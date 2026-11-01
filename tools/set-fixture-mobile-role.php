<?php

// Assign the synthetic Android account one additional role in disposable CI only.
if (getenv('SRD_ALLOW_MYSQL_FIXTURES') !== '1') {
    throw new RuntimeException('Explicit local fixture permission required.');
}

$userId = $argv[1] ?? '';
$organizationId = $argv[2] ?? '';
$targetRole = $argv[3] ?? 'registrar';
if (! preg_match('/^[0-9a-fA-F-]{36}$/', $userId)
    || ! preg_match('/^[0-9a-fA-F-]{36}$/', $organizationId)
    || ! in_array($targetRole, ['registrar', 'viewer'], true)) {
    throw new RuntimeException('Invalid synthetic mobile role fixture request.');
}

require '/app/services/identity/vendor/autoload.php';
$app = require '/app/services/identity/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
if (! app()->environment('local') || config('database.default') !== 'mysql') {
    throw new RuntimeException('Only the local synthetic MySQL environment is supported.');
}

Illuminate\Support\Facades\DB::transaction(function () use ($userId, $organizationId) {
    $db = Illuminate\Support\Facades\DB::connection();
    $fixtureExists = $db->table('users')->where('id', $userId)->where('email', 'android@srd-e2e.test')->exists();
    if (! $fixtureExists) {
        throw new RuntimeException('Selected user is not the synthetic Android fixture.');
    }

    if ($db->table('auth_sessions')->where('user_id', $userId)->whereNull('revoked_at')->exists()) {
        throw new RuntimeException('Revoke the synthetic fixture session before changing its role.');
    }

    $expectedRole = $targetRole === 'registrar' ? 'viewer' : 'registrar';
    $memberships = $db->table('memberships')->where('user_id', $userId)->where('active', true)->lockForUpdate()->get();
    if ($memberships->count() !== 1 || $memberships->first()->organization_id !== $organizationId
        || $memberships->first()->role !== $expectedRole) {
        throw new RuntimeException('Expected only the synthetic membership with the prior role in organization A.');
    }

    $membership = $memberships->first();
    $updated = $db->table('memberships')->where('id', $membership->id)->where('user_id', $userId)
        ->where('organization_id', $organizationId)->where('active', true)->where('role', $expectedRole)
        ->update(['role' => $targetRole, 'version' => ((int) $membership->version) + 1]);
    if ($updated !== 1) {
        throw new RuntimeException('Could not assign the synthetic registrar role.');
    }
});

echo "Synthetic mobile membership role updated.\n";
