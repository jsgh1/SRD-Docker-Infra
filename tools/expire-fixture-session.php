<?php

// Browser-test helper: touch only the selected synthetic fixture session.
$id = $argv[1] ?? '';
if (! preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD', $id)) {
    throw new RuntimeException('Invalid session ID.');
}
$fixture = json_decode(file_get_contents(getenv('SRD_FIXTURE_PATH') ?: '/tmp/e2e-fixture.json'), true);
if (! is_array($fixture)) {
    throw new RuntimeException('Synthetic fixture document is invalid.');
}
require '/tmp/srd-fixture-safety.php';
srdAssertSyntheticFixture($fixture);
require '/app/services/identity/vendor/autoload.php';
$app = require '/app/services/identity/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$service = 'identity';
srdAssertBootstrappedFixtureTarget($service);
$viewerId = $fixture['users']['viewer']['id'] ?? '';
if (! srdFixtureIsUuid($viewerId) || ! Illuminate\Support\Facades\DB::table('users')->where('id', $viewerId)->where('email', $fixture['users']['viewer']['email'])->exists()) {
    throw new RuntimeException('Selected session owner is not a synthetic fixture user.');
}
$updated = Illuminate\Support\Facades\DB::table('auth_sessions')
    ->where('id', $id)->where('user_id', $viewerId)
    ->whereNull('revoked_at')->update(['last_activity_at' => now()->subMinutes(31)]);
if ($updated !== 1) {
    throw new RuntimeException('Selected fixture session was not found.');
}
echo "Synthetic viewer session marked idle.\n";
