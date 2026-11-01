<?php

// Observe only the synthetic Android account in the disposable CI database.
$userId = $argv[1] ?? '';
$expected = filter_var($argv[2] ?? null, FILTER_VALIDATE_INT);
if (! preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD', $userId) || ! in_array($expected, [0, 1], true)) {
    throw new RuntimeException('Invalid synthetic session assertion.');
}

require '/tmp/srd-fixture-safety.php';
require '/app/services/identity/vendor/autoload.php';
$app = require '/app/services/identity/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
srdAssertBootstrappedFixtureTarget('identity');

$syntheticUser = Illuminate\Support\Facades\DB::table('users')
    ->where('id', $userId)
    ->whereIn('email', ['android@srd-e2e.test', 'android-registrar@srd-e2e.test'])
    ->exists();
if (! $syntheticUser) {
    throw new RuntimeException('Session assertion target is not a synthetic Android fixture.');
}

$active = Illuminate\Support\Facades\DB::table('auth_sessions')
    ->where('user_id', $userId)->whereNull('revoked_at')->count();
if ($active !== $expected) {
    fwrite(STDERR, 'Synthetic mobile session count did not match the expected state.');
    exit(1);
}

echo "Synthetic mobile session state matches expectation.\n";
