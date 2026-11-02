<?php
declare(strict_types=1);

require __DIR__.'/fixture-safety.php';

$base = [
    'app_env' => 'local',
    'driver' => 'mysql',
    'allow_mysql' => '1',
    'host' => 'mysql',
    'port' => '3306',
    'database' => 'srd_identity',
    'compose_project' => 'srd-p10-auth-41339212022-1',
];

$rejected = 0;
$check = static function (string $name, callable $assertion) use (&$rejected): void {
    try {
        $assertion();
    } catch (RuntimeException) {
        $rejected++;
        return;
    }

    fwrite(STDERR, "FAIL {$name}: unsafe fixture target was accepted.\n");
    exit(1);
};

srdAssertFixtureTarget('identity', $base);
$check('non-local environment', static fn () => srdAssertFixtureTarget('identity', [...$base, 'app_env' => 'production']));
$check('missing MySQL permission', static fn () => srdAssertFixtureTarget('identity', [...$base, 'allow_mysql' => null]));
$check('external database host', static fn () => srdAssertFixtureTarget('identity', [...$base, 'host' => 'db.example.test']));
$check('unexpected database port', static fn () => srdAssertFixtureTarget('identity', [...$base, 'port' => '3307']));
$check('wrong service database', static fn () => srdAssertFixtureTarget('identity', [...$base, 'database' => 'srd_records']));
$check('production Compose project', static fn () => srdAssertFixtureTarget('identity', [...$base, 'compose_project' => 'srd-production']));
$check('missing Compose project', static fn () => srdAssertFixtureTarget('identity', [...$base, 'compose_project' => null]));
$check('unknown fixture service', static fn () => srdAssertFixtureTarget('production', $base));
$check('SQLite without explicit permission', static fn () => srdAssertFixtureTarget('identity', ['app_env' => 'local', 'driver' => 'sqlite']));
srdAssertFixtureTarget('identity', ['app_env' => 'local', 'driver' => 'sqlite', 'allow_sqlite' => '1']);

$fixture = [
    'password' => str_repeat('a', 36),
    'orgA' => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'orgB' => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'termsA' => 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    'termsB' => 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    'users' => [],
    'mobile_user' => ['id' => 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111', 'email' => 'android@srd-e2e.test'],
];
foreach (['admin', 'registrar', 'treasurer', 'auditor', 'viewer', 'superadmin'] as $role) {
    $fixture['users'][$role] = ['id' => 'aaaaaaaa-aaaa-4aaa-8aaa-'.str_pad((string) (count($fixture['users']) + 1), 12, '0', STR_PAD_LEFT), 'email' => $role.'@srd-e2e.test'];
}
srdAssertSyntheticFixture($fixture);
$check('non-synthetic fixture email', static function () use ($fixture): void {
    $unsafe = $fixture;
    $unsafe['users']['admin']['email'] = 'real@example.com';
    srdAssertSyntheticFixture($unsafe);
});
$check('short fixture password', static function () use ($fixture): void {
    $unsafe = $fixture;
    $unsafe['password'] = 'password';
    srdAssertSyntheticFixture($unsafe);
});

echo 'PASS fixture safety: 1 valid MySQL target, 1 explicit SQLite target, '.$rejected.' unsafe cases rejected.'.PHP_EOL;
