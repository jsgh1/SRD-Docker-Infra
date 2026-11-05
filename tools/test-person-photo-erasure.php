<?php

// Run only inside the Files container. Creates and removes one synthetic organization.
require '/app/services/files/vendor/autoload.php';
$app = require '/app/services/files/bootstrap/app.php';
$app->make(\Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$org = (string) \Illuminate\Support\Str::uuid();
$person = (string) \Illuminate\Support\Str::uuid();
$actor = (string) \Illuminate\Support\Str::uuid();
$blobs = [bin2hex(random_bytes(24)), bin2hex(random_bytes(24))];
$retryPerson = (string) \Illuminate\Support\Str::uuid();
$retryBlob = bin2hex(random_bytes(24));
$contents = ['current synthetic photo', 'replaced synthetic photo'];
$folder = realpath(config('photos.objects'));
if (!$folder || !is_dir($folder)) throw new RuntimeException('Private storage unavailable.');
try {
    \Illuminate\Support\Facades\DB::table('file_quotas')->insert([
        'organization_id' => $org, 'reserved_bytes' => strlen($contents[0]) + strlen($contents[1]),
    ]);
    foreach ($blobs as $index => $blob) {
        $target = $folder.DIRECTORY_SEPARATOR.$blob.'.png';
        if (file_put_contents($target, $contents[$index]) !== strlen($contents[$index])) {
            throw new RuntimeException('Synthetic blob could not be written.');
        }
    }
    \Illuminate\Support\Facades\DB::table('person_photos')->insert([
        'organization_id' => $org, 'person_id' => $person, 'slot' => 'person',
        'version' => 1, 'blob_id' => $blobs[0], 'bytes' => strlen($contents[0]),
        'sha256' => hash('sha256', $contents[0]), 'width' => 1, 'height' => 1,
    ]);
    \Illuminate\Support\Facades\DB::table('file_garbage')->insert([
        'blob_id' => $blobs[1], 'organization_id' => $org, 'person_id' => $person,
        'bytes' => strlen($contents[1]),
    ]);
    $principal = ['organization_id' => $org, 'user_id' => $actor,
        'correlation_id' => (string) \Illuminate\Support\Str::uuid()];
    $store = app(\SrdFiles\PhotoStorage::class);
    $store->purgePerson($principal, $person);
    $store->purgePerson($principal, $person);
    foreach ($blobs as $blob) if (file_exists($folder.DIRECTORY_SEPARATOR.$blob.'.png')) {
        throw new RuntimeException('A synthetic blob survived erasure.');
    }
    if (\Illuminate\Support\Facades\DB::table('person_photos')->where('organization_id', $org)->exists()
        || \Illuminate\Support\Facades\DB::table('file_garbage')->where('organization_id', $org)->exists()
        || \Illuminate\Support\Facades\DB::table('file_deleted_person_blobs')->where('organization_id', $org)->exists()
        || (int) \Illuminate\Support\Facades\DB::table('file_quotas')->where('organization_id', $org)->value('reserved_bytes') !== 0) {
        throw new RuntimeException('Synthetic erasure did not reconcile its metadata or quota.');
    }
    $retryPath = $folder.DIRECTORY_SEPARATOR.$retryBlob.'.png';
    if (!mkdir($retryPath)) throw new RuntimeException('Synthetic failure path unavailable.');
    \Illuminate\Support\Facades\DB::table('file_quotas')->where('organization_id', $org)
        ->update(['reserved_bytes' => 12]);
    \Illuminate\Support\Facades\DB::table('person_photos')->insert([
        'organization_id' => $org, 'person_id' => $retryPerson, 'slot' => 'person',
        'version' => 1, 'blob_id' => $retryBlob, 'bytes' => 12,
        'sha256' => hash('sha256', 'retry-photo!'), 'width' => 1, 'height' => 1,
    ]);
    try {
        $store->purgePerson($principal, $retryPerson);
        throw new RuntimeException('Synthetic invalid file was incorrectly acknowledged.');
    } catch (RuntimeException $error) {
        if ($error->getMessage() === 'Synthetic invalid file was incorrectly acknowledged.') throw $error;
    }
    if (!\Illuminate\Support\Facades\DB::table('file_deleted_person_blobs')
        ->where('organization_id', $org)->where('person_id', $retryPerson)->exists()) {
        throw new RuntimeException('Failed cleanup lost its durable retry marker.');
    }
    rmdir($retryPath);
    file_put_contents($retryPath, 'retry-photo!');
    $store->purgePerson($principal, $retryPerson);
    if (file_exists($retryPath)
        || \Illuminate\Support\Facades\DB::table('file_deleted_person_blobs')->where('organization_id', $org)->exists()
        || (int) \Illuminate\Support\Facades\DB::table('file_quotas')->where('organization_id', $org)->value('reserved_bytes') !== 0) {
        throw new RuntimeException('Synthetic retry did not finish physical cleanup.');
    }
    echo "Synthetic photo erasure and retry passed.\n";
} finally {
    \Illuminate\Support\Facades\DB::table('person_photos')->where('organization_id', $org)->delete();
    \Illuminate\Support\Facades\DB::table('file_deleted_person_blobs')->where('organization_id', $org)->delete();
    \Illuminate\Support\Facades\DB::table('file_garbage')->where('organization_id', $org)->delete();
    \Illuminate\Support\Facades\DB::table('file_deleted_persons')->where('organization_id', $org)->delete();
    \Illuminate\Support\Facades\DB::table('outbox_events')->where('organization_id', $org)->delete();
    \Illuminate\Support\Facades\DB::table('file_quotas')->where('organization_id', $org)->delete();
    foreach ($blobs as $blob) {
        $target = $folder.DIRECTORY_SEPARATOR.$blob.'.png';
        if (is_file($target)) unlink($target);
    }
    $retryPath = $folder.DIRECTORY_SEPARATOR.$retryBlob.'.png';
    if (is_file($retryPath)) unlink($retryPath);
    if (is_dir($retryPath)) rmdir($retryPath);
}
