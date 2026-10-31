<?php

// Observe only the synthetic Android account in the disposable CI database.
if (getenv('SRD_ALLOW_MYSQL_FIXTURES') !== '1') {
    throw new RuntimeException('Explicit local fixture permission required.');
}

$userId = $argv[1] ?? '';
$expected = filter_var($argv[2] ?? null, FILTER_VALIDATE_INT);
if (! preg_match('/^[0-9a-fA-F-]{36}$/', $userId) || ! in_array($expected, [0, 1], true)) {
    throw new RuntimeException('Invalid synthetic session assertion.');
}

require '/app/services/identity/vendor/autoload.php';
$app = require '/app/services/identity/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
if (! app()->environment('local') || config('database.default') !== 'mysql') {
    throw new RuntimeException('Only the local synthetic MySQL environment is supported.');
}

$active = Illuminate\Support\Facades\DB::table('auth_sessions')
    ->where('user_id', $userId)->whereNull('revoked_at')->count();
if ($active !== $expected) {
    fwrite(STDERR, 'Synthetic mobile session count did not match the expected state.');
    exit(1);
}

echo "Synthetic mobile session state matches expectation.\n";
