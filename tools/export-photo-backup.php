<?php
// Binary output only. Executed in a one-off Files container while SRD writers are stopped.
require 'vendor/autoload.php';
$app=require 'bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
set_exception_handler(function(Throwable $e):void{fwrite(STDERR,"Photo export failed\n");exit(1);});
$root=config('photos.objects');
if(!is_dir($root)||is_link($root))throw new RuntimeException('Invalid object directory');
// Require every registered object, including pending removals; never silently publish an incomplete copy.
$references=Illuminate\Support\Facades\DB::table('person_photos')->whereNotNull('blob_id')->select('blob_id','bytes','sha256')->get();
$references=$references->concat(Illuminate\Support\Facades\DB::table('asset_photos')->whereNotNull('blob_id')->select('blob_id','bytes','sha256')->get());
$garbage=Illuminate\Support\Facades\DB::table('file_garbage')->select('blob_id','bytes')->get();
foreach($references->concat($garbage) as $row){
    if(!preg_match('/^[a-f0-9]{48}$/D',$row->blob_id))throw new RuntimeException('Invalid reference');
    $file=$root.'/'.$row->blob_id.'.png';
    if(is_link($file)||!is_file($file)||filesize($file)!==(int)$row->bytes)throw new RuntimeException('Missing referenced object');
    if(isset($row->sha256)&&!hash_equals($row->sha256,hash_file('sha256',$file)))throw new RuntimeException('Damaged referenced object');
}
if(Illuminate\Support\Facades\Schema::hasTable('folder_documents')){
    foreach(Illuminate\Support\Facades\DB::table('folder_documents')->where('ready',true)->get() as $row){
        if(!preg_match('/^[a-f0-9]{48}$/D',$row->blob_id))throw new RuntimeException('Invalid document reference');
        $file=$root.'/'.$row->blob_id.'.bin';
        if(is_link($file)||!is_file($file)||filesize($file)!==(int)$row->bytes||!hash_equals($row->sha256,hash_file('sha256',$file)))throw new RuntimeException('Missing or damaged document');
    }
}
$count=0;
foreach(new DirectoryIterator($root) as $entry){
    if($entry->isDot())continue;
    $name=$entry->getFilename();
    if(++$count>100000||!preg_match('/^[a-f0-9]{48}\.(png|bin)$/D',$name)||$entry->isLink()||!$entry->isFile())throw new RuntimeException('Invalid object');
    $size=$entry->getSize();if($size===0&&str_ends_with($name,'.bin'))continue;
    if($size<1||$size>(str_ends_with($name,'.bin')?20:5)*1024*1024)throw new RuntimeException('Invalid object size');
    $content=file_get_contents($entry->getPathname());if(strlen($content)!==$size)throw new RuntimeException('Incomplete image');
    $metadata=json_encode(['name'=>$name,'size'=>$size,'sha256'=>hash('sha256',$content)],JSON_THROW_ON_ERROR);
    echo pack('N',strlen($metadata)),$metadata,$content;
}
echo pack('N',0);
