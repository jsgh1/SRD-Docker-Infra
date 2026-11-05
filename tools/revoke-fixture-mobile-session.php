<?php

// Revoke only the active session belonging to the disposable Android CI account.
$userId = $argv[1] ?? '';
if (! preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD', $userId)) {
    throw new RuntimeException('Invalid synthetic user ID.');
}

require '/tmp/srd-fixture-safety.php';
require '/app/services/identity/vendor/autoload.php';
$app = require '/app/services/identity/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
srdAssertBootstrappedFixtureTarget('identity');

$db = Illuminate\Support\Facades\DB::table('users')->where('id', $userId)->where('email', 'android@srd-e2e.test')->exists();
if (! $db) {
    throw new RuntimeException('Selected user is not the synthetic Android fixture.');
}

$sessions = Illuminate\Support\Facades\DB::table('auth_sessions')
    ->where('user_id', $userId)
    ->whereNull('revoked_at')
    ->pluck('id');
if ($sessions->count() !== 1) {
    throw new RuntimeException('Expected exactly one active synthetic Android session.');
}

$updated = Illuminate\Support\Facades\DB::table('auth_sessions')
    ->where('id', $sessions->first())
    ->where('user_id', $userId)
    ->whereNull('revoked_at')
    ->update(['revoked_at' => now()]);
if ($updated !== 1) {
    throw new RuntimeException('Synthetic Android session was not revoked.');
}

echo "Synthetic Android session revoked.\n";
