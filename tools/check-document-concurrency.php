<?php
// Run only in Files against local MySQL with explicit synthetic-fixture authorization.
// Each run creates a new synthetic organization; it never edits pre-existing rows.
require 'vendor/autoload.php';
$app=require 'bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use SrdFiles\FolderDocumentStore;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
set_exception_handler(function(Throwable $error):void {
 fwrite(STDERR,($error instanceof RuntimeException&&!($error instanceof Illuminate\Database\QueryException)?$error->getMessage():'Concurrency check failed')."\n");exit(1);
});

function check(bool $condition,string $message):void { if(!$condition)throw new RuntimeException($message); }
function waitFor(callable $condition,float $seconds=20):void {
 $until=microtime(true)+$seconds;
 while(!$condition()){check(microtime(true)<$until,'Concurrency barrier timed out');usleep(20000);}
}
check(getenv('SRD_ALLOW_MYSQL_FIXTURES')==='1','Explicit synthetic-fixture authorization required');
check(DB::connection()->getDriverName()==='mysql','This check requires MySQL');
DB::statement('SET SESSION innodb_lock_wait_timeout = 15');

if(($argv[1]??'')==='--worker'){
 $input=json_decode(file_get_contents($argv[2]),true,512,JSON_THROW_ON_ERROR);
 $prefix=$argv[3];file_put_contents($prefix.'.ready','ready');
 waitFor(fn()=>is_file($input['gate']));file_put_contents($prefix.'.entered','entered');
 try {
  $store=$app->make(FolderDocumentStore::class);
  $operation=$input['operation'];
  if($operation['action']==='upload'){
   // Limit only this test instance; neither configuration nor existing quotas change.
   $scanner=new SrdFiles\UpdatedScanner(new SrdFiles\ClamdScanner(config('photos.scanner'),15),config('photos.signature_marker'));
   $signallingScanner=new class($scanner,$prefix.'.scanned') implements SrdFiles\Scanner {
    public function __construct(private SrdFiles\Scanner $scanner,private string $signal){}
    public function assertClean(string $path):void {$this->scanner->assertClean($path);file_put_contents($this->signal,'clean');}
   };
   $store=new FolderDocumentStore(new SrdFiles\OfficeDocumentGate($signallingScanner,config('photos.quarantine')),config('photos.objects'),$operation['quota']);
   $store->put($input['principal'],$operation['id'],null,$operation['name'],file_get_contents($operation['fixture']));
  }
  elseif(in_array($operation['action'],['folder-rename','folder-delete'],true)){
   $deleting=$operation['action']==='folder-delete';
   $request=Illuminate\Http\Request::create('/internal/v1/folders/'.$operation['id'],$deleting?'DELETE':'PATCH',$deleting?['confirm'=>true,'version'=>$operation['version']]:['name'=>$operation['name'],'version'=>$operation['version']]);
   $request->attributes->set('issuer','gateway');$request->attributes->set('principal',$input['principal']);
   $app->instance('request',$request);$controller=$app->make(App\Http\Controllers\FolderController::class);
   if($deleting)$controller->destroy($request,$operation['id']);else $controller->rename($request,$operation['id']);
  }
  elseif($operation['action']==='rename')$store->rename($input['principal'],$operation['id'],$operation['name'],$operation['version']);
  else $store->move($input['principal'],$operation['id'],$operation['folder'],$operation['version']);
  $result=['outcome'=>'committed'];
 }catch(SrdFiles\PhotoQuotaExceeded){$result=['outcome'=>'quota_exceeded'];}
 catch(HttpExceptionInterface $e){$result=['outcome'=>$e->getStatusCode()===409?'conflict':($e->getStatusCode()===404?'blocked':'unexpected'),'status'=>$e->getStatusCode()];}
 catch(Illuminate\Validation\ValidationException $e){$result=['outcome'=>'blocked','status'=>422];}
 catch(Illuminate\Database\QueryException $e){$result=['outcome'=>($e->errorInfo[0]??null)==='23000'&&(int)($e->errorInfo[1]??0)===1062?'conflict':'unexpected','driver_code'=>(int)($e->errorInfo[1]??0)];}
 catch(Throwable $e){$result=['outcome'=>'unexpected','exception'=>get_class($e)];}
 file_put_contents($prefix.'.result',json_encode($result,JSON_THROW_ON_ERROR));
 exit($result['outcome']==='unexpected'?1:0);
}

$org=(string)Str::uuid();$user=(string)Str::uuid();
$principal=['organization_id'=>$org,'user_id'=>$user,'session_id'=>(string)Str::uuid(),'role'=>'admin'];
$directory=sys_get_temp_dir().'/srd-document-concurrency-'.$org;
check(mkdir($directory,0700),'Cannot create isolated concurrency directory');
$folders=[];
foreach(['Origen uno','Origen dos','Destino','Destino temporal'] as $name){
 $id=(string)Str::uuid();$folders[]=$id;
 DB::table('internal_folders')->insert(['id'=>$id,'organization_id'=>$org,'parent_id'=>null,'parent_key'=>'00000000-0000-0000-0000-000000000000','name'=>$name,'name_key'=>hash('sha256',mb_strtolower($name)),'version'=>1,'created_by'=>$user,'created_at'=>now(),'updated_at'=>now()]);
}
$zip=new ZipArchive;$fixture=$directory.'/synthetic.docx';
check($zip->open($fixture,ZipArchive::CREATE|ZipArchive::EXCL)===true,'Cannot create synthetic Office fixture');
$zip->addFromString('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
$zip->addFromString('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
$zip->addFromString('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SRD synthetic concurrency check</w:t></w:r></w:p></w:body></w:document>');
check($zip->close(),'Cannot finish synthetic Office fixture');$bytes=file_get_contents($fixture);
$store=$app->make(FolderDocumentStore::class);$documents=[];
foreach([[null,'Version.docx'],[$folders[0],'Colision.docx'],[$folders[1],'COLISION.docx']] as [$folder,$name]){
 $documents[]=$store->put($principal,(string)Str::uuid(),$folder,$name,$bytes);
}

function race(array $principal,array $operations,string $directory,int $number,array $expected=['committed','conflict']):array {
 $gate=$directory.'/gate-'.$number;$workers=[];
 try {
  DB::beginTransaction();
  DB::table('file_quotas')->where('organization_id',$principal['organization_id'])->lockForUpdate()->first();
  foreach($operations as $index=>$operation){
   $prefix=$directory.'/worker-'.$number.'-'.$index;$manifest=$prefix.'.json';
   file_put_contents($manifest,json_encode(['principal'=>$principal,'operation'=>$operation,'gate'=>$gate],JSON_THROW_ON_ERROR));
   $process=proc_open([PHP_BINARY,__FILE__,'--worker',$manifest,$prefix],[0=>['file','/dev/null','r'],1=>['file',$prefix.'.log','w'],2=>['file',$prefix.'.log','a']],$pipes,getcwd());
   check(is_resource($process),'Cannot launch independent worker');$workers[]=['process'=>$process,'prefix'=>$prefix];
  }
  waitFor(fn()=>count(array_filter($workers,fn($w)=>is_file($w['prefix'].'.ready')))===count($workers));
  file_put_contents($gate,'release');
  waitFor(fn()=>count(array_filter($workers,fn($w)=>is_file($w['prefix'].'.entered')))===count($workers));
  if(count(array_filter($operations,fn($op)=>$op['action']==='upload'))===count($operations))
   waitFor(fn()=>count(array_filter($workers,fn($w)=>is_file($w['prefix'].'.scanned')))===count($workers));
  usleep(300000);
  foreach($workers as $worker)check(!is_file($worker['prefix'].'.result'),'Writer bypassed organization quota lock');
  DB::commit();
  waitFor(fn()=>count(array_filter($workers,fn($w)=>is_file($w['prefix'].'.result')))===count($workers));
  $results=array_map(fn($w)=>json_decode(file_get_contents($w['prefix'].'.result'),true,512,JSON_THROW_ON_ERROR),$workers);
  $outcomes=array_column($results,'outcome');sort($outcomes);
  sort($expected);check($outcomes===$expected,'Concurrent outcomes did not match expectations');return $results;
 }finally{
  if(DB::transactionLevel()>0)DB::rollBack();
  foreach($workers as $worker){if(proc_get_status($worker['process'])['running'])proc_terminate($worker['process']);proc_close($worker['process']);}
 }
}

$before=DB::table('folder_documents')->where('organization_id',$org)->get()->keyBy('id');
race($principal,[['action'=>'rename','id'=>$documents[0]['id'],'name'=>'Version final.docx','version'=>1],['action'=>'move','id'=>$documents[0]['id'],'folder'=>$folders[2],'version'=>1]],$directory,1);
$version=DB::table('folder_documents')->where('id',$documents[0]['id'])->first();
check((int)$version->version===2,'Concurrent version increment invalid');
check(($version->name==='Version final.docx'&&$version->folder_id===null)||($version->name==='Version.docx'&&$version->folder_id===$folders[2]),'Losing operation changed metadata');
check(DB::table('outbox_events')->where('organization_id',$org)->where('resource_id',$version->id)->whereIn('action',['document.renamed','document.moved'])->count()===1,'Unexpected version-race audit count');
race($principal,[['action'=>'move','id'=>$documents[1]['id'],'folder'=>$folders[2],'version'=>1],['action'=>'move','id'=>$documents[2]['id'],'folder'=>$folders[2],'version'=>1]],$directory,2);
$colliding=DB::table('folder_documents')->whereIn('id',[$documents[1]['id'],$documents[2]['id']])->get();
check($colliding->where('folder_id',$folders[2])->count()===1,'Destination collision did not preserve a single winner');
foreach($colliding as $row)check($row->folder_id===$folders[2]?(int)$row->version===2:($row->folder_id===$before[$row->id]->folder_id&&(int)$row->version===1),'Collision rollback changed source');
check(DB::table('outbox_events')->where('organization_id',$org)->whereIn('resource_id',[$documents[1]['id'],$documents[2]['id']])->where('action','document.moved')->count()===1,'Unexpected collision audit count');
race($principal,[['action'=>'folder-rename','id'=>$folders[2],'name'=>'Destino final','version'=>1],['action'=>'rename','id'=>$documents[0]['id'],'name'=>'Documento final.docx','version'=>2]],$directory,3,['committed','committed']);
check((int)DB::table('internal_folders')->where('id',$folders[2])->value('version')===2,'Concurrent folder rename failed');
check((int)DB::table('folder_documents')->where('id',$documents[0]['id'])->value('version')===3,'Concurrent document rename failed');
check(DB::table('outbox_events')->where('organization_id',$org)->where('resource_id',$folders[2])->where('action','folder.renamed')->count()===1,'Concurrent folder audit count invalid');
race($principal,[['action'=>'folder-delete','id'=>$folders[3],'version'=>1],['action'=>'move','id'=>$documents[0]['id'],'folder'=>$folders[3],'version'=>3]],$directory,4,['committed','blocked']);
$destinationExists=DB::table('internal_folders')->where('id',$folders[3])->exists();
$last=DB::table('folder_documents')->where('id',$documents[0]['id'])->first();
check($destinationExists?($last->folder_id===$folders[3]&&(int)$last->version===4):($last->folder_id!==$folders[3]&&(int)$last->version===3),'Deletion race orphaned or changed document');
check(DB::table('outbox_events')->where('organization_id',$org)->where('resource_id',$folders[3])->where('action','folder.deleted')->count()===($destinationExists?0:1),'Deletion race audit invalid');
foreach(DB::table('folder_documents')->where('organization_id',$org)->get() as $row){
 foreach(['blob_id','bytes','sha256','mime','created_by','created_at'] as $key)check($row->$key===$before[$row->id]->$key,'Original metadata changed');
 check($row->parent_key===($row->folder_id??'00000000-0000-0000-0000-000000000000'),'Parent key invalid');
 check(hash_equals(hash('sha256',$bytes),hash_file('sha256',config('photos.objects').'/'.$row->blob_id.'.bin')),'Private bytes changed');
}
check((int)DB::table('file_quotas')->where('organization_id',$org)->value('reserved_bytes')===3*strlen($bytes),'Shared quota changed');
$uploads=[];$testQuota=4*strlen($bytes);
foreach(['Carga uno.docx','Carga dos.docx'] as $name)$uploads[]=['action'=>'upload','id'=>(string)Str::uuid(),'name'=>$name,'quota'=>$testQuota,'fixture'=>$fixture];
race($principal,$uploads,$directory,5,['committed','quota_exceeded']);
$uploaded=DB::table('folder_documents')->where('organization_id',$org)->whereIn('id',array_column($uploads,'id'))->get();
check($uploaded->count()===1&&(bool)$uploaded[0]->ready,'Quota race left a duplicate or unfinished upload');
$winner=$uploaded[0];$loser=array_values(array_filter($uploads,fn($op)=>$op['id']!==$winner->id))[0];
check(!DB::table('folder_documents')->where('id',$loser['id'])->exists(),'Rejected upload reserved a row');
check(DB::table('outbox_events')->where('organization_id',$org)->whereIn('resource_id',array_column($uploads,'id'))->where('action','document.created')->count()===1,'Quota race duplicated creation audit');
check((int)DB::table('file_quotas')->where('organization_id',$org)->value('reserved_bytes')===$testQuota,'Quota exceeded or charged twice');
check(hash_equals(hash('sha256',$bytes),hash_file('sha256',config('photos.objects').'/'.$winner->blob_id.'.bin')),'Quota-race bytes invalid');
$retry=array_values(array_filter($uploads,fn($op)=>$op['id']===$winner->id))[0];
race($principal,[$retry,$retry],$directory,6,['committed','committed']);
$afterRetry=DB::table('folder_documents')->where('id',$winner->id)->first();
check($afterRetry->blob_id===$winner->blob_id&&(int)$afterRetry->version===1,'Retry replaced a completed object');
check(DB::table('folder_documents')->where('organization_id',$org)->count()===4,'Retry duplicated documents');
check((int)DB::table('file_quotas')->where('organization_id',$org)->value('reserved_bytes')===$testQuota,'Retry charged full quota again');
check(DB::table('outbox_events')->where('organization_id',$org)->where('resource_id',$winner->id)->where('action','document.created')->count()===1,'Retry duplicated creation event');
echo json_encode(['synthetic_organization'=>$org,'races_passed'=>6,'independent_workers'=>12,'documents_verified'=>4,'quota_lock_verified'=>true,'conflict_events_absent'=>true,'deletion_race_preserves_parent'=>true,'quota_boundary_verified'=>true,'completed_retry_at_full_quota_verified'=>true],JSON_THROW_ON_ERROR)."\n";
