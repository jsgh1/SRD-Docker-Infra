<?php
// Read-only, value-free snapshot of a synthetic account's authentication state.
$root = getenv('SRD_ROOT') ?: dirname(__DIR__);
$fixturePath = getenv('SRD_FIXTURE_PATH') ?: "$root/.local/e2e-fixture.json";
require getenv('SRD_FIXTURE_SAFETY_PATH') ?: '/tmp/srd-fixture-safety.php';
require "$root/services/identity/vendor/autoload.php";
$app = require "$root/services/identity/bootstrap/app.php";
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
srdAssertBootstrappedFixtureTarget('identity');
$fixture = json_decode(file_get_contents($fixturePath), true, 512, JSON_THROW_ON_ERROR);
srdAssertSyntheticFixture($fixture);
$key = $argv[1] ?? 'mobile_user';
if (! in_array($key, ['mobile_user', 'mobile_registrar_user'], true)) {
    throw new RuntimeException('synthetic-account-key-not-allowlisted');
}
$identity = $fixture[$key] ?? null;
if (! is_array($identity) || empty($identity['id']) || empty($identity['email'])) {
    throw new RuntimeException('synthetic-account-not-configured');
}
$user = Illuminate\Support\Facades\DB::table('users')->where('id', $identity['id'])->where('email', $identity['email'])->first();
$emailKey = 'login:' . hash('sha256', strtolower($identity['email']));
$challenges = Illuminate\Support\Facades\DB::table('auth_challenges')->where('user_id', $identity['id'])->where('purpose', 'login');
$events = Illuminate\Support\Facades\DB::table('outbox_events')->where('actor_id', $identity['id']);
$organizationEvents = Illuminate\Support\Facades\DB::table('outbox_events')->where('organization_id', $fixture['orgA']);
$membership = Illuminate\Support\Facades\DB::table('memberships')->where('user_id', $identity['id'])->where('organization_id', $fixture['orgA'])->where('active', true)->first();
$challengeCountLastHour = (clone $challenges)->where('created_at', '>', now()->subHour())->count();
$latestChallengeAt = (clone $challenges)->latest('created_at')->value('created_at');
$correlationId = getenv('SRD_P20_CORRELATION_ID') ?: '';
$correlatedIdentityEvents = [];
if (Illuminate\Support\Str::isUuid($correlationId)) {
    foreach (['auth.login_rejected', 'auth.challenge_sent', 'auth.delivery_failed', 'auth.code_rejected'] as $action) {
        $correlatedIdentityEvents[$action] = Illuminate\Support\Facades\DB::table('outbox_events')
            ->where('organization_id', $fixture['orgA'])
            ->where('correlation_id', $correlationId)
            ->where('action', $action)
            ->count();
    }
}
$result = [
    'service' => 'identity',
    'account_key' => $key,
    'account_exists' => (bool) $user,
    'account_active' => (bool) ($user?->active ?? false),
    'password_matches_fixture' => (bool) ($user && Illuminate\Support\Facades\Hash::check($fixture['password'], $user->password)),
    'organization_a_membership' => (bool) $membership,
    'membership_role' => $membership->role ?? null,
    'login_rate_limit_attempts' => Illuminate\Support\Facades\RateLimiter::attempts($emailKey),
    'login_rate_limit_blocked_at_10' => Illuminate\Support\Facades\RateLimiter::tooManyAttempts($emailKey, 10),
    'login_challenges_last_hour' => $challengeCountLastHour,
    'mfa_resend_cooldown_active' => $latestChallengeAt !== null && Illuminate\Support\Carbon::parse($latestChallengeAt)->gt(now()->subSeconds(60)),
    'mfa_hourly_limit_reached' => $challengeCountLastHour >= 5,
    'unconsumed_login_challenges' => (clone $challenges)->whereNull('consumed_at')->count(),
    'unsent_login_challenges' => (clone $challenges)->whereNull('sent_at')->count(),
    // The application intentionally omits actor_id on rejected-login events.
    'organization_login_rejected_events' => (clone $organizationEvents)->where('action', 'auth.login_rejected')->count(),
    'challenge_sent_events' => (clone $events)->where('action', 'auth.challenge_sent')->count(),
    'delivery_failed_events' => (clone $events)->where('action', 'auth.delivery_failed')->count(),
    'diagnostic_correlation_id_supplied' => Illuminate\Support\Str::isUuid($correlationId),
    'diagnostic_identity_events' => $correlatedIdentityEvents,
    'active_sessions' => $user ? Illuminate\Support\Facades\DB::table('auth_sessions')->where('user_id', $identity['id'])->whereNull('revoked_at')->where('expires_at', '>', now())->count() : 0,
    'captured_at_utc' => now('UTC')->toIso8601String(),
    'contains_email_password_hash_or_identifier' => false,
];
echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . PHP_EOL;
