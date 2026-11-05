<?php
// Ejecutar dentro de Records. Crea o retira únicamente las personas sintéticas de esta prueba.
require __DIR__.'/vendor/autoload.php';
$app = require __DIR__.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

[$script, $action, $organization, $user, $marker, $jobId] = array_pad($argv, 6, null);
if (!in_array($action, ['seed', 'cleanup'], true)
    || !Str::isUuid($organization) || !Str::isUuid($user)
    || !preg_match('/^[a-f0-9]{8}$/D', (string) $marker)
    || ($jobId !== null && !Str::isUuid($jobId))) {
    throw new RuntimeException('Argumentos de prueba inválidos.');
}
$prefix = 'PDFL-'.$marker.'-';
DB::transaction(function () use ($action, $organization, $user, $prefix, $jobId) {
    $people = DB::table('persons')->where('organization_id', $organization)
        ->where('document_number', 'like', $prefix.'%');
    $count = (clone $people)->count();
    if ($action === 'seed') {
        if ($count !== 0) throw new RuntimeException('La marca de prueba ya existe.');
        for ($start = 1; $start <= 501; $start += 100) {
            $rows = [];
            for ($i = $start; $i < min($start + 100, 502); $i++) {
                $rows[] = ['id' => (string) Str::uuid(), 'organization_id' => $organization,
                    'document_type' => 'CC', 'document_number' => $prefix.sprintf('%04d', $i),
                    'first_names' => 'Persona PDF de prueba', 'status' => 'pending', 'version' => 1,
                    'created_by' => $user, 'created_at' => now(), 'updated_at' => now()];
            }
            DB::table('persons')->insert($rows);
        }
        return;
    }
    if ($count > 501) throw new RuntimeException('La limpieza encontró más personas de las esperadas.');
    if ($jobId !== null) {
        $job = DB::table('person_export_jobs')->where('id', $jobId)
            ->where('organization_id', $organization)->where('user_id', $user)->where('format', 'pdf');
        if ((clone $job)->count() > 1) throw new RuntimeException('Trabajo ambiguo.');
        $job->delete();
        DB::table('outbox_events')->where('organization_id', $organization)
            ->where('resource_id', $jobId)->delete();
    }
    $people->delete();
});
echo "PASS $action $prefix\n";
