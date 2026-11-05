<?php
declare(strict_types=1);

/**
 * Fail-closed checks for fixture scripts that write to a MySQL QA database.
 * Do not use this policy to make production data available to tests.
 */
function srdFixtureDatabaseName(string $service): string
{
    $databases = [
        'identity' => 'srd_identity',
        'configuration' => 'srd_configuration',
        'calendar' => 'srd_calendar',
        'audit' => 'srd_audit',
        'records' => 'srd_records',
        'files' => 'srd_files',
        'notifications' => 'srd_notifications',
        'treasury' => 'srd_treasury',
        'inventory' => 'srd_inventory',
        'chat' => 'srd_chat',
    ];

    if (! isset($databases[$service])) {
        throw new RuntimeException('Fixture service is not allowlisted.');
    }

    return $databases[$service];
}

function srdAssertFixtureTarget(string $service, array $context): void
{
    if (($context['app_env'] ?? null) !== 'local') {
        throw new RuntimeException('Fixture writes require APP_ENV=local.');
    }

    $driver = $context['driver'] ?? null;
    if ($driver === 'sqlite') {
        if (($context['allow_sqlite'] ?? null) !== '1') {
            throw new RuntimeException('SQLite fixture writes require explicit permission.');
        }

        return;
    }

    if ($driver !== 'mysql' || ($context['allow_mysql'] ?? null) !== '1') {
        throw new RuntimeException('Fixture writes require explicitly authorized MySQL QA.');
    }

    if (($context['host'] ?? null) !== 'mysql' || (string) ($context['port'] ?? '') !== '3306') {
        throw new RuntimeException('Fixture MySQL host is not the isolated Compose service.');
    }

    if (($context['database'] ?? null) !== srdFixtureDatabaseName($service)) {
        throw new RuntimeException('Fixture database is not allowlisted for this service.');
    }

    $project = $context['compose_project'] ?? '';
    $allowedProject = preg_match(
        '/^srd-(?:p[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]+-[0-9]+|casa-qa-[0-9]{8}|qa-[a-z0-9]+(?:-[a-z0-9]+)*|mi-entorno)$/D',
        $project,
    ) === 1;
    if (! $allowedProject) {
        throw new RuntimeException('Fixture Compose project is not on the QA allowlist.');
    }
}

function srdAssertSyntheticFixture(array $fixture): void
{
    if (! preg_match('/^[a-f0-9]{32,128}$/i', (string) ($fixture['password'] ?? ''))) {
        throw new RuntimeException('Fixture password is not a generated synthetic value.');
    }

    foreach (['orgA', 'orgB', 'termsA', 'termsB'] as $key) {
        if (! srdFixtureIsUuid($fixture[$key] ?? null)) {
            throw new RuntimeException('Fixture organization or terms identifier is invalid.');
        }
    }

    foreach (['users' => ['admin', 'registrar', 'treasurer', 'auditor', 'viewer', 'superadmin']] as $group => $roles) {
        foreach ($roles as $role) {
            $user = $fixture[$group][$role] ?? null;
            if (! is_array($user) || ! srdFixtureIsUuid($user['id'] ?? null) || ! srdFixtureEmail($user['email'] ?? null)) {
                throw new RuntimeException('Fixture user is not a synthetic test identity.');
            }
        }
    }

    foreach (['mobile_user', 'mobile_registrar_user'] as $key) {
        $user = $fixture[$key] ?? null;
        if ($user !== null && (! is_array($user) || ! srdFixtureIsUuid($user['id'] ?? null) || ! srdFixtureEmail($user['email'] ?? null))) {
            throw new RuntimeException('Mobile fixture is not a synthetic test identity.');
        }
    }

    foreach (['codeA', 'codeB'] as $key) {
        $code = $fixture[$key] ?? null;
        if ($code !== null && (! is_string($code) || ! preg_match('/^(?:srd-e2e-[a-z0-9-]+|e2e-[a-f0-9-]+-[ab])$/iD', $code))) {
            throw new RuntimeException('Fixture organization code is not synthetic.');
        }
    }

    srdAssertSyntheticValues($fixture);
}

function srdAssertSyntheticValues(array $value): void
{
    foreach ($value as $key => $item) {
        if (is_array($item)) {
            srdAssertSyntheticValues($item);
            continue;
        }

        if (is_string($item) && str_ends_with(strtolower((string) $key), 'email') && ! srdFixtureEmail($item)) {
            throw new RuntimeException('Fixture contains a non-synthetic email address.');
        }

        if (is_string($item) && (strtolower((string) $key) === 'id' || str_ends_with(strtolower((string) $key), '_id'))
            && ! srdFixtureIsUuid($item)) {
            throw new RuntimeException('Fixture contains an invalid synthetic identifier.');
        }
    }
}

function srdFixtureEmail(mixed $value): bool
{
    return is_string($value)
        && preg_match('/^[a-z0-9._+-]+@srd-e2e\.test$/iD', $value) === 1;
}

function srdFixtureIsUuid(mixed $value): bool
{
    return is_string($value)
        && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD', $value) === 1;
}

function srdAssertBootstrappedFixtureTarget(string $service): void
{
    $connection = config('database.connections.'.config('database.default'), []);
    srdAssertFixtureTarget($service, [
        'app_env' => app()->environment(),
        'driver' => config('database.default'),
        'allow_sqlite' => getenv('SRD_ALLOW_SQLITE_FIXTURES') ?: null,
        'allow_mysql' => getenv('SRD_ALLOW_MYSQL_FIXTURES') ?: null,
        'host' => $connection['host'] ?? null,
        'port' => $connection['port'] ?? null,
        'database' => $connection['database'] ?? null,
        'compose_project' => getenv('SRD_COMPOSE_PROJECT') ?: null,
    ]);
}
