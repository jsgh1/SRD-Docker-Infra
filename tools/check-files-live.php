<?php
// Synthetic integration probe inside Files. Never reads existing personal records.
require 'vendor/autoload.php';
$app = require 'bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
set_exception_handler(function (Throwable $error): void {
    fwrite(STDERR, json_encode(['passed' => false, 'stage' => $GLOBALS['srd_probe_stage'] ?? 'setup', 'exception' => get_class($error), 'code' => $error->getCode()])."\n");
    exit(1);
});
$marker = trim(@file_get_contents(config('photos.signature_marker')) ?: '');
if (!ctype_digit($marker) || (int)$marker < time()-172800) throw new RuntimeException('Signature update confirmation required before probe');
$socket = stream_socket_client(config('photos.scanner'), $errno, $error, 3);
if (!$socket) throw new RuntimeException('Scanner is not available');
stream_set_timeout($socket, 3);
fwrite($socket, "zVERSION\0");
$scannerVersion = rtrim((string) fread($socket, 512), "\0\r\n");
fclose($socket);
if (!str_starts_with($scannerVersion, 'ClamAV ')) throw new RuntimeException('Invalid scanner version');
$uuid = fn () => (string) Illuminate\Support\Str::uuid();
$principal = ['organization_id' => $uuid(), 'user_id' => $uuid(), 'session_id' => $uuid(), 'role' => 'admin'];
$manifest = storage_path('framework/cache/photo-probe-'.$principal['organization_id'].'.json');
$document = 'PHOTO-'.bin2hex(random_bytes(8));
file_put_contents($manifest, json_encode(['principal' => $principal, 'document' => $document, 'person_id' => null]));
chmod($manifest, 0600);
config(['srd.service' => 'gateway', 'srd.urls.files' => 'http://127.0.0.1:8000']);
$client = new Srd\InternalClient;
$GLOBALS['srd_probe_stage'] = 'create synthetic person';
$person = $client->call('records', 'POST', 'persons', [
    'document_type' => 'CC', 'document_number' => $document,
    'first_names' => 'Prueba sintética de fotografías', 'status' => 'pending',
    'authorization_basis' => 'Datos generados para prueba local', 'authorization_purpose' => 'Verificación técnica',
], $principal);
$id = $person['id'];
file_put_contents($manifest, json_encode(['principal' => $principal, 'document' => $document, 'person_id' => $id]));
$path = 'persons/'.$id.'/photos';
$image = imagecreatetruecolor(3, 2); ob_start(); imagejpeg($image); $jpeg = ob_get_clean(); imagedestroy($image);
// Camera orientation 6: the stored raster is 3x2, the displayed PNG must be 2x3.
$exif = "Exif\0\0II\x2a\x00".pack('V',8).pack('v',1).pack('vvVv',0x112,3,1,6)."\0\0".pack('V',0);
$bytes = substr($jpeg,0,2)."\xff\xe1".pack('n',strlen($exif)+2).$exif.substr($jpeg,2);
$upload = ['name' => 'synthetic.jpg', 'content' => base64_encode($bytes), 'version' => 0];
$completed = false;
try {
    foreach (['person', 'document', 'property'] as $slot) {
        $GLOBALS['srd_probe_stage'] = 'upload '.$slot;
        $saved = $client->call('files', 'PUT', $path.'/'.$slot, $upload, $principal);
        if ($saved['version'] !== 1) throw new RuntimeException('Unexpected version');
        if ($saved['width'] !== 2 || $saved['height'] !== 3) throw new RuntimeException('Orientation metadata not normalized');
        $GLOBALS['srd_probe_stage'] = 'read '.$slot;
        $read = $client->call('files', 'GET', $path.'/'.$slot, [], $principal);
        $decoded = base64_decode($read['content'], true);
        $dimensions = getimagesizefromstring($decoded);
        if ($read['mime'] !== 'image/png' || !$dimensions || $dimensions[0] !== 2 || $dimensions[1] !== 3 || str_contains($decoded, "Exif\0\0")) throw new RuntimeException('Image orientation or metadata not normalized');
    }
    $GLOBALS['srd_probe_stage'] = 'replacement and isolation';
    $client->call('files', 'PUT', $path.'/person', array_replace($upload, ['version' => 1]), $principal);
    try {
        $client->call('files', 'PUT', $path.'/person', array_replace($upload, ['version' => 1]), $principal);
        throw new RuntimeException('Stale version accepted');
    } catch (Symfony\Component\HttpKernel\Exception\HttpExceptionInterface $e) {
        if ($e->getStatusCode() !== 409) throw $e;
    }
    $other = array_replace($principal, ['organization_id' => $uuid()]);
    try {
        $client->call('files', 'GET', $path.'/person', [], $other);
        throw new RuntimeException('Cross-organization access accepted');
    } catch (Symfony\Component\HttpKernel\Exception\HttpExceptionInterface $e) {
        if ($e->getStatusCode() !== 404) throw $e;
    }
    $completed = true;
} finally {
    $GLOBALS['srd_probe_stage'] = 'delete synthetic person with photos still attached';
    $blobs = Illuminate\Support\Facades\DB::table('person_photos')->where('organization_id', $principal['organization_id'])->where('person_id', $id)->whereNotNull('blob_id')->pluck('blob_id');
    $client->call('records', 'DELETE', 'persons/'.$id, ['confirmed' => true, 'version' => 1], $principal);
    config(['srd.service' => 'files']);
    $GLOBALS['srd_probe_stage'] = 'wait for real deletion dispatcher and collector';
    $deadline = time() + 180;
    do {
        $deleted = Illuminate\Support\Facades\DB::table('file_deleted_persons')->where('organization_id', $principal['organization_id'])->where('person_id', $id)->exists();
        $reserved = (int) Illuminate\Support\Facades\DB::table('file_quotas')->where('organization_id', $principal['organization_id'])->value('reserved_bytes');
        if ($deleted && $reserved === 0) break;
        if (time() >= $deadline) throw new RuntimeException('Scheduled deletion not completed; synthetic manifest retained');
        sleep(2);
    } while (true);
    foreach ($blobs as $blob) if (file_exists(config('photos.objects').'/'.$blob.'.png')) throw new RuntimeException('Synthetic object still exists');
    if (Illuminate\Support\Facades\DB::table('person_photos')->where('organization_id', $principal['organization_id'])->where('person_id', $id)->exists()) throw new RuntimeException('Photo metadata still exists');
}
if (!$completed) throw new RuntimeException('Probe incomplete');
if ((int)Illuminate\Support\Facades\DB::table('file_quotas')->where('organization_id', $principal['organization_id'])->value('reserved_bytes') !== 0) throw new RuntimeException('Quota not released');
$events = Illuminate\Support\Facades\DB::table('outbox_events')->where('organization_id', $principal['organization_id'])->pluck('id');
$GLOBALS['srd_probe_stage'] = 'deliver synthetic audit';
foreach ($events as $event) app(Srd\OutboxPublisher::class)->publishOne($event);
config(['srd.service' => 'gateway']);
$audit = $client->call('audit', 'GET', 'events', ['service' => 'files'], $principal);
if ($audit['total'] !== 5) throw new RuntimeException('Photo audit not fully delivered');
unlink($manifest);
echo json_encode(['passed' => true, 'scanner_version' => $scannerVersion, 'synthetic_only' => true, 'slots' => 3, 'jpeg_orientation' => 6, 'normalized_dimensions' => [2,3], 'exif_removed' => true, 'replacement_conflict' => true, 'cross_organization_denied' => true, 'quota_after_cleanup' => 0, 'audit_events' => 5, 'person_deleted' => true, 'scheduled_photo_cleanup' => true, 'physical_objects_removed' => true], JSON_PRETTY_PRINT)."\n";
