<?php
// Read-only consistency check inside the Files service. Prints counts, never object names or private data.
require 'vendor/autoload.php';
$app = require 'bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Facades\DB;

$root = config('photos.objects');
$count = 0;
foreach (DB::table('asset_photos')->whereNotNull('blob_id')->get(['blob_id', 'bytes', 'sha256']) as $row) {
    if (!preg_match('/^[a-f0-9]{48}$/D', $row->blob_id)) throw new RuntimeException('Invalid blob reference');
    $file = $root.'/'.$row->blob_id.'.png';
    if (is_link($file) || !is_file($file) || filesize($file) !== (int) $row->bytes
        || !hash_equals($row->sha256, hash_file('sha256', $file))) throw new RuntimeException('Asset image mismatch');
    $count++;
}
$documents=Illuminate\Support\Facades\Schema::hasTable('folder_documents')?' + (SELECT COALESCE(SUM(d.bytes),0) FROM folder_documents d WHERE d.organization_id=q.organization_id)':'';
$mismatch = DB::selectOne('SELECT COUNT(*) AS total FROM file_quotas q WHERE q.reserved_bytes <>
    (SELECT COALESCE(SUM(p.bytes),0) FROM person_photos p WHERE p.organization_id=q.organization_id)
    + (SELECT COALESCE(SUM(a.bytes),0) FROM asset_photos a WHERE a.organization_id=q.organization_id)
    + (SELECT COALESCE(SUM(g.bytes),0) FROM file_garbage g WHERE g.organization_id=q.organization_id)'.$documents);
if ((int) $mismatch->total !== 0) throw new RuntimeException('Photo quota mismatch');
$events = DB::table('outbox_events')->where('action', 'like', 'asset_photo.%');
$published = (clone $events)->whereNotNull('published_at')->count();
$pending = (clone $events)->whereNull('published_at')->count();
echo "PASS active asset photo objects: $count; shared quotas reconciled; audit published: $published; pending: $pending\n";
