<?php

// Browser-test helper: touch only the selected synthetic fixture session.
if (getenv('SRD_ALLOW_MYSQL_FIXTURES') !== '1') {
    throw new RuntimeException('Explicit local fixture permission required.');
}
$id = $argv[1] ?? '';
if (! preg_match('/^[0-9a-fA-F-]{36}$/', $id)) {
    throw new RuntimeException('Invalid session ID.');
}
$fixture = json_decode(file_get_contents(getenv('SRD_FIXTURE_PATH') ?: '/tmp/e2e-fixture.json'), true);
require '/app/services/identity/vendor/autoload.php';
$app = require '/app/services/identity/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
if (! app()->environment('local') || config('database.default') !== 'mysql') {
    throw new RuntimeException('Only the local synthetic MySQL environment is supported.');
}
$updated = Illuminate\Support\Facades\DB::table('auth_sessions')
    ->where('id', $id)->where('user_id', $fixture['users']['viewer']['id'])
    ->whereNull('revoked_at')->update(['last_activity_at' => now()->subMinutes(31)]);
if ($updated !== 1) {
    throw new RuntimeException('Selected fixture session was not found.');
}
echo "Synthetic viewer session marked idle.\n";
