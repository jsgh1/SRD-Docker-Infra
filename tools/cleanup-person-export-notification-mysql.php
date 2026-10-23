<?php
// Elimina exclusivamente el aviso de la junta sintética creada por check-person-export-jobs-mysql.php.
require __DIR__.'/vendor/autoload.php';
$app = require __DIR__.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$organization = getenv('SRD_SMOKE_ORG');
if (!is_string($organization) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $organization)) {
    throw new RuntimeException('Falta el identificador UUID de la junta sintética.');
}
$db = Illuminate\Support\Facades\DB::class;
$unexpected = $db::table('notifications')->where('organization_id', $organization)
    ->where('kind', '!=', 'export_ready')->exists();
if ($unexpected) throw new RuntimeException('La junta tiene avisos ajenos a esta prueba; no se borra nada.');
$db::transaction(function () use ($db, $organization) {
    $db::table('notifications')->where('organization_id', $organization)->where('kind', 'export_ready')->delete();
    $db::table('outbox_events')->where('organization_id', $organization)
        ->where('action', 'notifications.created')->delete();
});
echo "PASS limpieza de aviso sintético $organization\n";
