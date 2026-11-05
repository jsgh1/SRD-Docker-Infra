<?php
// Synthetic photo for the backup/restore exercise. Never selects existing user records.
require 'vendor/autoload.php';
$app=require 'bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
set_exception_handler(function(Throwable $e):void{fwrite(STDERR,json_encode(['passed'=>false,'exception'=>get_class($e)])."\n");exit(1);});
$manifest=storage_path('framework/cache/backup-photo-fixture.json');
$action=getenv('SRD_BACKUP_PHOTO_ACTION');
config(['srd.service'=>'gateway','srd.urls.files'=>'http://127.0.0.1:8000']);
$client=new Srd\InternalClient;
if($action==='prepare'){
    if(file_exists($manifest))throw new RuntimeException('Previous synthetic fixture requires review');
    $uuid=fn()=>(string)Illuminate\Support\Str::uuid();
    $p=['organization_id'=>$uuid(),'user_id'=>$uuid(),'session_id'=>$uuid(),'role'=>'admin'];
    $fixture=['principal'=>$p,'document'=>'BACKUP-'.bin2hex(random_bytes(8)),'id'=>null];
    file_put_contents($manifest,json_encode($fixture));chmod($manifest,0600);
    $created=$client->call('records','POST','persons',['document_type'=>'CC','document_number'=>$fixture['document'],'first_names'=>'Synthetic backup photo','status'=>'pending','authorization_basis'=>'Synthetic local test','authorization_purpose'=>'Backup restoration test'],$p);
    $fixture['id']=$created['id'];file_put_contents($manifest,json_encode($fixture));
    $image=imagecreatetruecolor(3,2);ob_start();imagepng($image);$bytes=ob_get_clean();imagedestroy($image);
    $client->call('files','PUT','persons/'.$fixture['id'].'/photos/person',['name'=>'synthetic.png','content'=>base64_encode($bytes),'version'=>0],$p);
    echo json_encode(['prepared'=>true,'synthetic_only'=>true])."\n";
}elseif($action==='cleanup'){
    if(!is_file($manifest)||is_link($manifest))throw new RuntimeException('No synthetic manifest');
    $fixture=json_decode(file_get_contents($manifest),true,512,JSON_THROW_ON_ERROR);
    if(!$fixture['id'])throw new RuntimeException('Incomplete synthetic fixture; inspect manifest');
    try{$client->call('records','DELETE','persons/'.$fixture['id'],['version'=>1,'confirmed'=>true],$fixture['principal']);}
    catch(Symfony\Component\HttpKernel\Exception\HttpExceptionInterface $e){if($e->getStatusCode()!==404)throw $e;}
    $deadline=time()+180;
    do{
        $org=$fixture['principal']['organization_id'];
        $deleted=Illuminate\Support\Facades\DB::table('file_deleted_persons')->where('organization_id',$org)->where('person_id',$fixture['id'])->exists();
        $quota=(int)Illuminate\Support\Facades\DB::table('file_quotas')->where('organization_id',$org)->value('reserved_bytes');
        if($deleted&&$quota===0)break;
        if(time()>=$deadline)throw new RuntimeException('Scheduled fixture cleanup pending');
        sleep(2);
    }while(true);
    unlink($manifest);echo json_encode(['cleaned'=>true,'quota'=>0])."\n";
}else throw new RuntimeException('Choose prepare or cleanup');
