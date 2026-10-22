<?php
foreach(['ImageRejected','ScannerUnavailable','Scanner','ClamdScanner','ImageGate','PhotoConflict','PhotoNotFound','PhotoQuotaExceeded','PhotoStorage','AssetPhotoStorage','PhotoStore'] as $c)require __DIR__.'/../services/files/app/'.$c.'.php';
use SrdFiles\{Scanner, ImageGate, PhotoStore, PhotoConflict, PhotoNotFound, PhotoQuotaExceeded};
function connection():PDO{return new PDO('mysql:host=mysql;dbname=srd_files_probe;charset=utf8mb4','root','',[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);}
function expect(bool $ok,string $message='Comprobación fallida'):void{if(!$ok)throw new RuntimeException($message);}
function rejects(callable $f,string $type):void{try{$f();}catch(Throwable $e){expect($e instanceof $type,get_class($e).': '.$e->getMessage());return;}throw new RuntimeException('Faltó rechazo: '.$type);}
$db=connection();$db->exec(file_get_contents(__DIR__.'/../services/files/database/schema.mysql.sql'));
$db->exec(file_get_contents(__DIR__.'/../services/files/database/asset-photos.mysql.sql'));
$db->exec(file_get_contents(__DIR__.'/../services/files/database/deleted-persons.mysql.sql'));
$base=realpath(__DIR__.'/..').'/.local/photo-storage';$root=$base.'/run-'.bin2hex(random_bytes(12));
mkdir($root,0700);mkdir($root.'/objects',0700);mkdir($root.'/quarantine',0700);
$scanner=new class implements Scanner{public function assertClean(string $path):void{}};
$gate=new ImageGate($root.'/quarantine',$scanner);
$authorize=fn(array $p,string $person,string $action):bool=>($p['enabled']??true)&&($p['resource_exists']??true)&&($action==='persons.read'||in_array($p['role'],['superadmin','admin','registrar'],true));
$store=new PhotoStore($db,$root.'/objects',$gate,$authorize);
$p=['organization_id'=>'11111111-1111-4111-8111-111111111111','user_id'=>'22222222-2222-4222-8222-222222222222','role'=>'admin'];
$person='33333333-3333-4333-8333-333333333333';
$image=imagecreatetruecolor(3,2);ob_start();imagepng($image);$png=ob_get_clean();imagedestroy($image);
$size=$gate->prepare('sample.png',$png)['size'];$results=[];
$check=function(string $name,Closure $f)use(&$results):void{try{$f();$results[]=['name'=>$name,'passed'=>true];}catch(Throwable $e){$results[]=['name'=>$name,'passed'=>false,'error'=>$e->getMessage()];}};
$check('three-slots-persist-and-read',function()use($store,$p,$person,$png){
    expect(count($store->list($p,$person))===3);
    foreach(PhotoStore::SLOTS as $slot){$saved=$store->put($p,$person,$slot,'sample.png',$png,0);expect($saved['version']===1&&$saved['present']);$out=$store->read($p,$person,$slot);expect($out['mime']==='image/png'&&hash('sha256',$out['content'])===$out['sha256']);expect(!isset($saved['blob_id']));}
});
$check('denied-resource-and-cross-organization',function()use($store,$p,$person,$png){
    foreach(['enabled','resource_exists']as $flag){$denied=$p+[$flag=>false];rejects(fn()=>$store->read($denied,$person,'person'),PhotoNotFound::class);rejects(fn()=>$store->put($denied,$person,'person','sample.png',$png,1),PhotoNotFound::class);}
    $other=array_replace($p,['organization_id'=>'44444444-4444-4444-8444-444444444444']);rejects(fn()=>$store->read($other,$person,'person'),PhotoNotFound::class);
    expect(!$store->list($other,$person)[0]['present']);
    rejects(fn()=>$store->put(array_replace($p,['role'=>'viewer']),$person,'person','sample.png',$png,1),PhotoNotFound::class);
});
$check('invalid-slots-and-stale-version-no-side-effects',function()use($store,$p,$person,$png,$db,$root){
    $before=$db->query('SELECT reserved_bytes FROM file_quotas')->fetchColumn();$files=count(glob($root.'/objects/*'));
    rejects(fn()=>$store->put($p,$person,'../other','sample.png',$png,0),InvalidArgumentException::class);
    rejects(fn()=>$store->put($p,$person,'person','sample.png',$png,0),PhotoConflict::class);
    expect($before===$db->query('SELECT reserved_bytes FROM file_quotas')->fetchColumn());expect($files===count(glob($root.'/objects/*')));
});
$check('replacement-reserves-old-until-cleaned',function()use($store,$p,$person,$png,$db,$size){
    $store->put($p,$person,'person','sample.png',$png,1);expect((int)$db->query('SELECT reserved_bytes FROM file_quotas')->fetchColumn()===$size*4);
    expect((int)$db->query('SELECT COUNT(*) FROM file_garbage')->fetchColumn()===1);expect($store->collect($p['organization_id'])===1);
    expect((int)$db->query('SELECT reserved_bytes FROM file_quotas')->fetchColumn()===$size*3);
});
$check('confirmed-versioned-delete-and-aba-protection',function()use($store,$p,$person,$png){
    rejects(fn()=>$store->delete($p,$person,'person',2,false),InvalidArgumentException::class);
    rejects(fn()=>$store->delete($p,$person,'person',1,true),PhotoConflict::class);
    $deleted=$store->delete($p,$person,'person',2,true);expect(!$deleted['present']&&$deleted['version']===3);
    rejects(fn()=>$store->read($p,$person,'person'),PhotoNotFound::class);rejects(fn()=>$store->put($p,$person,'person','sample.png',$png,0),PhotoConflict::class);
    expect($store->put($p,$person,'person','sample.png',$png,3)['version']===4);$store->collect($p['organization_id']);
});
$check('corrupt-object-is-never-served',function()use($store,$p,$person,$db,$root){
    $id=$db->query("SELECT blob_id FROM person_photos WHERE slot='person'")->fetchColumn();$path=$root.'/objects/'.$id.'.png';$bytes=file_get_contents($path);
    try{file_put_contents($path,'damaged');rejects(fn()=>$store->read($p,$person,'person'),PhotoNotFound::class);}finally{file_put_contents($path,$bytes);}
});
$check('cleanup-failure-preserves-reservation-and-retries',function()use($store,$p,$person,$db,$root){
    $id=$db->query("SELECT blob_id FROM person_photos WHERE slot='document'")->fetchColumn();$path=$root.'/objects/'.$id.'.png';
    $store->delete($p,$person,'document',1,true);$reserved=(int)$db->query('SELECT reserved_bytes FROM file_quotas')->fetchColumn();
    rename($path,$path.'.held');mkdir($path);
    try{rejects(fn()=>$store->collect($p['organization_id']),RuntimeException::class);expect((int)$db->query('SELECT reserved_bytes FROM file_quotas')->fetchColumn()===$reserved);}
    finally{rmdir($path);rename($path.'.held',$path);}
    expect($store->collect($p['organization_id'])===1);expect(!file_exists($path));
});
$check('quota-blocks-upload-and-releases-after-cleanup',function()use($db,$root,$gate,$authorize,$p,$person,$png,$size){
    $small=new PhotoStore($db,$root.'/objects',$gate,$authorize,$size*2);rejects(fn()=>$small->put($p,$person,'document','sample.png',$png,2),PhotoQuotaExceeded::class);
    $small->delete($p,$person,'property',1,true);rejects(fn()=>$small->put($p,$person,'document','sample.png',$png,2),PhotoQuotaExceeded::class);
    $small->collect($p['organization_id']);expect($small->put($p,$person,'document','sample.png',$png,2)['present']);
});
$check('outbox-metadata-no-content',function()use($db){$events=$db->query('SELECT * FROM outbox_events')->fetchAll(PDO::FETCH_ASSOC);expect(count($events)>=8);foreach($events as $event){expect(in_array($event['action'],['photo.created','photo.replaced','photo.deleted'],true));expect($event['published_at']===null);expect(!str_contains(json_encode($event),'sample.png'));}});
$check('asset-slots-share-private-quota-and-live-object-protection',function()use($db,$root,$gate,$p,$png){
    $asset='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $authorizer=fn(array $principal,string $id,string $action):bool=>$id===$asset && in_array($action,['inventory.read','inventory.write'],true);
    $photos=new PhotoStore($db,$root.'/objects',$gate,$authorizer,PhotoStore::QUOTA_BYTES,'asset');
    expect(array_column($photos->list($p,$asset),'slot')===PhotoStore::ASSET_SLOTS,'Asset slots');
    $saved=$photos->put($p,$asset,'front','sample.png',$png,0);
    expect($saved['present']&&$saved['version']===1,'Asset upload');
    $row=$db->query("SELECT blob_id,bytes FROM asset_photos WHERE asset_id='$asset' AND slot='front'")->fetch(PDO::FETCH_ASSOC);
    expect(strlen($photos->read($p,$asset,'front')['content'])===(int)$row['bytes'],'Asset read length');
    $q=$db->prepare('INSERT INTO file_garbage (blob_id,organization_id,bytes) VALUES (?,?,?)');
    $q->execute([$row['blob_id'],$p['organization_id'],$row['bytes']]);
    try{rejects(fn()=>$photos->collect($p['organization_id']),RuntimeException::class);}
    finally{$q=$db->prepare('DELETE FROM file_garbage WHERE blob_id=?');$q->execute([$row['blob_id']]);}
    expect($photos->delete($p,$asset,'front',1,true)['present']===false,'Asset delete');
    expect($photos->collect($p['organization_id'])===1,'Asset collection');
    expect(!file_exists($root.'/objects/'.$row['blob_id'].'.png'),'Asset object removed');
});
$check('transaction-failure-removes-unreferenced-object',function()use($db,$store,$p,$person,$png,$root){
    $reserved=(int)$db->query('SELECT reserved_bytes FROM file_quotas')->fetchColumn();$files=glob($root.'/objects/*');
    rejects(fn()=>$store->put($p+['correlation_id'=>'invalid'],$person,'person','sample.png',$png,4),InvalidArgumentException::class);
    expect((int)$db->query('SELECT reserved_bytes FROM file_quotas')->fetchColumn()===$reserved);expect(glob($root.'/objects/*')===$files);expect($store->read($p,$person,'person')['version']===4);
});
$check('authorization-rechecked-after-image-processing',function()use($db,$root,$gate,$p,$person,$png){
    $calls=0;$authorizer=function()use(&$calls):bool{return ++$calls===1;};$guarded=new PhotoStore($db,$root.'/objects',$gate,$authorizer);
    rejects(fn()=>$guarded->put($p,$person,'person','sample.png',$png,4),PhotoNotFound::class);expect($calls===2);
});
$check('collector-refuses-live-object',function()use($db,$store,$p,$root){
    $row=$db->query("SELECT blob_id,bytes FROM person_photos WHERE slot='person'")->fetch(PDO::FETCH_ASSOC);
    $q=$db->prepare('INSERT INTO file_garbage (blob_id,organization_id,bytes) VALUES (?,?,?)');$q->execute([$row['blob_id'],$p['organization_id'],$row['bytes']]);
    try{rejects(fn()=>$store->collect($p['organization_id']),RuntimeException::class);expect(is_file($root.'/objects/'.$row['blob_id'].'.png'));}
    finally{$q=$db->prepare('DELETE FROM file_garbage WHERE blob_id=?');$q->execute([$row['blob_id']]);}
});
$check('person-purge-idempotent-isolated-and-blocks-late-upload',function()use($store,$p,$png,$db,$root){
    $id='99999999-9999-4999-8999-999999999999';
    foreach(PhotoStore::SLOTS as $slot)$store->put($p,$id,$slot,'sample.png',$png,0);
    $other=array_replace($p,['organization_id'=>'88888888-8888-4888-8888-888888888888']);
    $store->put($other,$id,'person','sample.png',$png,0);
    $before=(int)$db->query("SELECT reserved_bytes FROM file_quotas WHERE organization_id='{$p['organization_id']}'")->fetchColumn();
    $store->purgePerson($p,$id);$store->purgePerson($p,$id);
    expect((int)$db->query("SELECT COUNT(*) FROM outbox_events WHERE action='photo.person_deleted' AND resource_id='$id'")->fetchColumn()===1);
    expect((int)$db->query("SELECT reserved_bytes FROM file_quotas WHERE organization_id='{$p['organization_id']}'")->fetchColumn()===$before);
    foreach($store->list($p,$id)as $r)expect(!$r['present']);
    rejects(fn()=>$store->put($p,$id,'person','sample.png',$png,0),PhotoNotFound::class);
    expect($store->read($other,$id,'person')['mime']==='image/png');
    expect($store->collect($p['organization_id'])>=3);
    $store->purgePerson($other,$id);expect($store->collect($other['organization_id'])===1);
    expect((int)$db->query("SELECT reserved_bytes FROM file_quotas WHERE organization_id='{$other['organization_id']}'")->fetchColumn()===0);
});
// Fork with independent PDO connections; a common start file aligns competing transactions.
$race=function(bool $sameSlot)use($root,$scanner,$authorize,$person,$png,$size):array{
    $org=$sameSlot?'55555555-5555-4555-8555-555555555555':'66666666-6666-4666-8666-666666666666';
    $prefix=$root.'/race-'.($sameSlot?'version':'quota');$children=[];
    for($i=0;$i<2;$i++){$pid=pcntl_fork();if($pid===0){$status='unexpected';try{
        $deadline=microtime(true)+20;while(!is_file($prefix.'.start')){if(microtime(true)>$deadline)throw new RuntimeException('Barrera vencida');usleep(10000);}
        $p=['organization_id'=>$org,'user_id'=>'22222222-2222-4222-8222-222222222222','role'=>'admin'];
        $local=new PhotoStore(connection(),$root.'/objects',new ImageGate($root.'/quarantine',$scanner),$authorize,$sameSlot?$size*10:$size);
        $local->put($p,$person,$sameSlot?'person':PhotoStore::SLOTS[$i],'sample.png',$png,0);$status='saved';
    }catch(PhotoConflict){$status='conflict';}catch(PhotoQuotaExceeded){$status='quota';}catch(Throwable $e){$status=get_class($e).': '.$e->getMessage();}file_put_contents($prefix.'.'.$i,$status);exit(0);}expect($pid>0);$children[]=$pid;}
    touch($prefix.'.start');foreach($children as $pid)pcntl_waitpid($pid,$status);$out=[file_get_contents($prefix.'.0'),file_get_contents($prefix.'.1')];sort($out);return $out;
};
// Do not inherit a live PDO socket across fork; each worker and the parent reconnect.
$store=null;$gate=null;$db=null;
$check('mysql-race-same-photo-one-version-wins',function()use($race){expect($race(true)===['conflict','saved']);});
$check('mysql-race-quota-only-one-slot-fits',function()use($race){expect($race(false)===['quota','saved']);});
$check('mysql-race-person-deletion-and-upload-never-resurrect',function()use($root,$scanner,$authorize,$person,$png,$p){
    $p=array_replace($p,['organization_id'=>'77777777-7777-4777-8777-777777777777']);
    $prefix=$root.'/race-deletion';$children=[];
    for($i=0;$i<2;$i++){
        $pid=pcntl_fork();
        if($pid===0){$status='ok';try{
            $deadline=microtime(true)+20;
            while(!is_file($prefix.'.start')){if(microtime(true)>$deadline)throw new RuntimeException('Barrier expired');usleep(10000);}
            $local=new PhotoStore(connection(),$root.'/objects',new ImageGate($root.'/quarantine',$scanner),$authorize);
            if($i===0)$local->purgePerson($p,$person);
            else {try{$local->put($p,$person,'person','sample.png',$png,0);}catch(PhotoNotFound){}}
        }catch(Throwable $e){$status=get_class($e).': '.$e->getMessage();}
        file_put_contents($prefix.'.'.$i,$status);exit(0);}
        expect($pid>0);$children[]=$pid;
    }
    touch($prefix.'.start');foreach($children as $pid)pcntl_waitpid($pid,$status);
    expect(file_get_contents($prefix.'.0')==='ok');expect(file_get_contents($prefix.'.1')==='ok');
    $localDb=connection();$local=new PhotoStore($localDb,$root.'/objects',new ImageGate($root.'/quarantine',$scanner),$authorize);
    foreach($local->list($p,$person)as $r)expect(!$r['present']);
    $local->collect($p['organization_id']);
    $q=$localDb->prepare('SELECT reserved_bytes FROM file_quotas WHERE organization_id=?');$q->execute([$p['organization_id']]);expect((int)$q->fetchColumn()===0);
});
$db=connection();
$check('quota-reconciles-active-plus-garbage',function()use($db){foreach($db->query('SELECT * FROM file_quotas')->fetchAll(PDO::FETCH_ASSOC)as $r){$q=$db->prepare('SELECT COALESCE(SUM(bytes),0) FROM (SELECT bytes FROM person_photos WHERE organization_id=? UNION ALL SELECT bytes FROM asset_photos WHERE organization_id=? UNION ALL SELECT bytes FROM file_garbage WHERE organization_id=?) x');$q->execute([$r['organization_id'],$r['organization_id'],$r['organization_id']]);expect((int)$q->fetchColumn()===(int)$r['reserved_bytes']);}});
$report=['database'=>$db->query('SELECT VERSION()')->fetchColumn(),'scanner'=>'Controlled test double; real scanner evidence is in file-safety/results.json','passed'=>count(array_filter($results,fn($r)=>$r['passed'])),'failed'=>count(array_filter($results,fn($r)=>!$r['passed'])),'cases'=>$results];
// Only files created in this random test directory; no recursion and no source/user files.
foreach(glob($root.'/objects/*')as $path){expect(is_file($path)&&!is_link($path));unlink($path);}rmdir($root.'/objects');expect(glob($root.'/quarantine/*')===[]);rmdir($root.'/quarantine');foreach(glob($root.'/*')as $path){expect(is_file($path)&&!is_link($path));unlink($path);}rmdir($root);
file_put_contents($base.'/results.json',json_encode($report,JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE));echo json_encode($report,JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE).PHP_EOL;exit($report['failed']?1:0);
