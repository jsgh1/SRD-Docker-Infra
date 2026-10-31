<?php

// Revoke only the active session belonging to the disposable Android CI account.
if (getenv('SRD_ALLOW_MYSQL_FIXTURES') !== '1') {
    throw new RuntimeException('Explicit local fixture permission required.');
}

$userId = $argv[1] ?? '';
if (! preg_match('/^[0-9a-fA-F-]{36}$/', $userId)) {
    throw new RuntimeException('Invalid synthetic user ID.');
}

require '/app/services/identity/vendor/autoload.php';
$app = require '/app/services/identity/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
if (! app()->environment('local') || config('database.default') !== 'mysql') {
    throw new RuntimeException('Only the local synthetic MySQL environment is supported.');
}

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
