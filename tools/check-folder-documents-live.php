<?php
// Read-only checks in Files; no names, content or credentials are printed.
require 'vendor/autoload.php';
$app=require 'bootstrap/app.php';$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
use Illuminate\Support\Facades\DB;
$root=config('photos.objects');$count=0;
foreach(DB::table('folder_documents')->where('ready',true)->get() as $r){
 if(!isset($r->version)||(int)$r->version<1||(int)$r->version>2147483647)throw new RuntimeException('Document version invalid');
 if($r->parent_key!==($r->folder_id??'00000000-0000-0000-0000-000000000000'))throw new RuntimeException('Document parent key mismatch');
 if(!hash_equals($r->name_key,hash('sha256',mb_strtolower($r->name))))throw new RuntimeException('Document name key mismatch');
 if(!preg_match('/^[a-f0-9]{48}$/D',$r->blob_id))throw new RuntimeException('Invalid reference');
 $file=$root.'/'.$r->blob_id.'.bin';
 if(is_link($file)||!is_file($file)||filesize($file)!==(int)$r->bytes||!hash_equals($r->sha256,hash_file('sha256',$file)))throw new RuntimeException('Document integrity failed');
 if($r->folder_id&&!DB::table('internal_folders')->where('organization_id',$r->organization_id)->where('id',$r->folder_id)->exists())throw new RuntimeException('Document folder mismatch');
 $count++;
}
$tombstones=0;$pendingRemovals=0;
foreach(DB::table('folder_documents')->where('delete_pending',true)->get() as $r){
 if($r->ready||$r->folder_id!==null||$r->parent_key!=='00000000-0000-0000-0000-000000000000'||$r->name_key!==hash('sha256','deleted-document:'.$r->id))throw new RuntimeException('Deleted document still visible or incorrectly isolated');
 $file=$root.'/'.$r->blob_id.'.bin';
 if(is_link($file))throw new RuntimeException('Deleted document path is a link');
 if((int)$r->bytes===0){
  if(is_file($file)||$r->sha256!==str_repeat('0',64))throw new RuntimeException('Collected document retains private bytes');
 }else{
  if(is_file($file)&&(filesize($file)!==(int)$r->bytes||!hash_equals($r->sha256,hash_file('sha256',$file))))throw new RuntimeException('Pending deleted document damaged');
  $pendingRemovals++;
 }
 $tombstones++;
}
$bad=DB::selectOne('SELECT COUNT(*) AS total FROM file_quotas q WHERE q.reserved_bytes <>
 (SELECT COALESCE(SUM(p.bytes),0) FROM person_photos p WHERE p.organization_id=q.organization_id)
 + (SELECT COALESCE(SUM(a.bytes),0) FROM asset_photos a WHERE a.organization_id=q.organization_id)
 + (SELECT COALESCE(SUM(g.bytes),0) FROM file_garbage g WHERE g.organization_id=q.organization_id)
 + (SELECT COALESCE(SUM(d.bytes),0) FROM folder_documents d WHERE d.organization_id=q.organization_id)');
if((int)$bad->total)throw new RuntimeException('Shared quota mismatch');
$events=DB::table('outbox_events')->where('action','like','document.%');
$deletedFolders=DB::table('outbox_events')->where('action','folder.deleted');
echo json_encode(['documents_verified'=>$count,'deleted_document_ids_retained'=>$tombstones,'document_removals_pending'=>$pendingRemovals,'shared_quotas_verified'=>true,'audit_published'=>(clone $events)->whereNotNull('published_at')->count(),'audit_pending'=>(clone $events)->whereNull('published_at')->count(),
 'folder_deletions_published'=>(clone $deletedFolders)->whereNotNull('published_at')->count(),'folder_deletions_pending'=>(clone $deletedFolders)->whereNull('published_at')->count()],JSON_THROW_ON_ERROR)."\n";
