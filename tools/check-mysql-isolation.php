<?php
// Read-only verification, executed inside one SRD service container.
require '/app/services/'.getenv('SRD_CHECK_SERVICE').'/vendor/autoload.php';
$app = require '/app/services/'.getenv('SRD_CHECK_SERVICE').'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$pdo = Illuminate\Support\Facades\DB::connection()->getPdo();
$service = getenv('SRD_CHECK_SERVICE');
if ($pdo->query('SELECT DATABASE()')->fetchColumn() !== 'srd_'.$service) throw new RuntimeException('Wrong own database');
$pdo->query('SELECT COUNT(*) FROM migrations')->fetchColumn();
$services = ['gateway', 'identity', 'configuration', 'records', 'audit', 'files', 'calendar', 'notifications', 'treasury', 'inventory', 'chat'];
foreach ($services as $other) {
    if ($other === $service) continue;
    try {
        $pdo->query('SELECT COUNT(*) FROM srd_'.$other.'.migrations');
    } catch (PDOException $e) {
        if (!in_array((int) ($e->errorInfo[1] ?? 0), [1044, 1142], true)) throw $e;
        continue;
    }
    throw new RuntimeException('Cross-database read allowed: '.$other);
}
echo $service.": own database accessible, ".(count($services) - 1)." foreign databases denied.\n";
