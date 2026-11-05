<?php
// Ejecutar dentro de Records. Sus datos se revierten; retirar el aviso con cleanup-person-export-notification-mysql.php.
require __DIR__.'/vendor/autoload.php';
$app = require __DIR__.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Application\PersonExportJobs;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

$organization = (string) Str::uuid();
$user = (string) Str::uuid();
echo "SMOKE_ORG:$organization\n";
$principal = ['organization_id' => $organization, 'user_id' => $user, 'role' => 'admin'];
$logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=';
DB::beginTransaction();
try {
    app(App\Application\PlanillaSettings::class)->update($principal, [
        'version' => 0, 'allowed_columns' => ['zone', 'phone'],
        'h1' => 'JUNTA COMUNAL', 'h2' => 'Sector norte', 'h3' => 'ASISTENCIA',
        'h1_en' => 'COMMUNITY BOARD', 'h2_en' => 'North area', 'h3_en' => 'ATTENDANCE',
        'logo_data' => $logo,
    ]);
    for ($start = 1; $start <= 501; $start += 100) {
        $rows = [];
        for ($i = $start; $i < min($start + 100, 502); $i++) {
            $rows[] = ['id' => (string) Str::uuid(), 'organization_id' => $organization,
                'document_type' => 'CC', 'document_number' => sprintf('SMOKE-%04d', $i),
                'first_names' => 'Persona sintética', 'status' => 'pending', 'version' => 1,
                'created_by' => $user, 'created_at' => now(), 'updated_at' => now()];
        }
        DB::table('persons')->insert($rows);
    }
    $jobs = app(PersonExportJobs::class);
    $queued = $jobs->create($principal, [], null, false, 'en')['data'];
    $queuedPdf = $jobs->create($principal, [], null, false, 'en', 'pdf')['data'];
    $pdfSnapshot = json_decode(DB::table('person_export_jobs')->where('id', $queuedPdf['id'])->value('snapshot_json'), true, 512, JSON_THROW_ON_ERROR);
    if (($pdfSnapshot['logo_data'] ?? null) !== $logo || count($pdfSnapshot['rows'] ?? []) !== 501) {
        throw new RuntimeException('No se capturó la instantánea PDF con el logo original.');
    }
    if ($queued['status'] !== 'queued' || $queued['count'] !== 501
        || $queuedPdf['status'] !== 'queued' || $queuedPdf['count'] !== 501
        || $queuedPdf['format'] !== 'pdf') throw new RuntimeException('No se crearon ambas colas.');
    DB::table('persons')->where('organization_id', $organization)
        ->where('document_number', 'SMOKE-0001')->update(['first_names' => 'Cambio posterior']);
    DB::table('planilla_settings')->where('organization_id', $organization)->update(['logo_data' => null]);
    Artisan::call('srd:person-export-jobs');
    if (DB::table('person_export_jobs')->whereIn('id', [$queued['id'], $queuedPdf['id']])
        ->whereNull('notification_sent_at')->exists()) {
        throw new RuntimeException('No se entregaron ambos avisos de disponibilidad.');
    }
    $ready = $jobs->status($principal, $queued['id'])['data'];
    if ($ready['status'] !== 'ready' || !isset($ready['ticket'])) throw new RuntimeException('El planificador no generó el archivo.');
    $file = $jobs->download($principal, $queued['id'], $ready['ticket'])['data'];
    $bytes = base64_decode($file['content'], true);
    if ($file['count'] !== 501 || !is_string($bytes) || !str_starts_with($bytes, 'PK')) {
        throw new RuntimeException('La descarga no es un Excel válido.');
    }
    $readyPdf = $jobs->status($principal, $queuedPdf['id'])['data'];
    if ($readyPdf['status'] !== 'ready' || $readyPdf['format'] !== 'pdf' || !isset($readyPdf['ticket'])) {
        throw new RuntimeException('El planificador no preparó el PDF.');
    }
    $pdf = $jobs->download($principal, $queuedPdf['id'], $readyPdf['ticket'])['data'];
    $pdfBytes = base64_decode($pdf['content'] ?? '', true);
    if ($pdf['count'] !== 501 || $pdf['mime'] !== 'application/pdf'
        || !is_string($pdfBytes) || !str_starts_with($pdfBytes, '%PDF-') || strlen($pdfBytes) < 1000
        || DB::table('person_export_jobs')->where('id', $queuedPdf['id'])->value('snapshot_json') !== '[]') {
        throw new RuntimeException('El trabajo no preparó el archivo PDF binario.');
    }
    echo "PASS MySQL: 501 personas sintéticas, dos colas, logo capturado, avisos entre servicios y Excel/PDF protegidos; trabajos revertidos.\n";
} finally {
    DB::rollBack();
}
