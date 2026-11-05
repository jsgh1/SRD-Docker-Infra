<?php

// Mutate or inspect only the disposable Android QA account's login challenge.
$action = $argv[1] ?? '';
$userId = $argv[2] ?? '';
$challengeId = $argv[3] ?? '';
if (! in_array($action, ['expire', 'assert-consumed'], true)
    || ! preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD', $userId)
    || ($action === 'assert-consumed' && ! preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD', $challengeId))) {
    throw new RuntimeException('Invalid synthetic challenge fixture request.');
}

require '/tmp/srd-fixture-safety.php';
require '/app/services/identity/vendor/autoload.php';
$app = require '/app/services/identity/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
srdAssertBootstrappedFixtureTarget('identity');

$db = Illuminate\Support\Facades\DB::connection();
$fixtureExists = $db->table('users')->where('id', $userId)->where('email', 'android@srd-e2e.test')->exists();
if (! $fixtureExists) {
    throw new RuntimeException('Selected user is not the synthetic Android fixture.');
}

if ($action === 'expire') {
    $pending = $db->table('auth_challenges')
        ->where('user_id', $userId)
        ->where('purpose', 'login')
        ->whereNotNull('sent_at')
        ->whereNull('consumed_at')
        ->orderByDesc('created_at')
        ->limit(2)
        ->get(['id']);
    if ($pending->count() !== 1) {
        throw new RuntimeException('Expected exactly one pending synthetic Android login challenge.');
    }

    $id = $pending->first()->id;
    $updated = $db->table('auth_challenges')
        ->where('id', $id)
        ->where('user_id', $userId)
        ->where('purpose', 'login')
        ->whereNull('consumed_at')
        ->update(['expires_at' => now()->subSecond()]);
    if ($updated !== 1) {
        throw new RuntimeException('Could not expire exactly one pending synthetic challenge.');
    }

    echo $id . PHP_EOL;
    exit(0);
}

$consumed = $db->table('auth_challenges')
    ->where('id', $challengeId)
    ->where('user_id', $userId)
    ->where('purpose', 'login')
    ->whereNotNull('consumed_at')
    ->exists();
if (! $consumed) {
    throw new RuntimeException('Synthetic login challenge was not consumed.');
}

echo "Synthetic login challenge state matches expectation.\n";
