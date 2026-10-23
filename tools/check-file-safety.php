<?php
// Synthetic images only. No user-provided file is read by this verification tool.
foreach (['ImageRejected','ScannerUnavailable','Scanner','ClamdScanner','ImageGate'] as $class) require __DIR__.'/../services/files/app/'.$class.'.php';
use SrdFiles\{ImageRejected, ScannerUnavailable, Scanner, ClamdScanner, ImageGate};
$root = realpath(__DIR__.'/..');
$base = $root.'/.local/file-safety';
if (!is_dir($base)) mkdir($base,0700,true);
$quarantine = $base.'/run-'.bin2hex(random_bytes(12));
mkdir($quarantine,0700);
$results = [];
function check(string $name, callable $action): void {
    global $results;
    try { $action(); $results[]=['name'=>$name,'passed'=>true]; }
    catch (Throwable $e) { $results[]=['name'=>$name,'passed'=>false,'error'=>$e->getMessage()]; }
}
function expect(bool $condition, string $message = 'Comprobación fallida'): void { if (!$condition) throw new RuntimeException($message); }
function rejects(callable $action, string $type): void {
    try { $action(); } catch (Throwable $e) { expect($e instanceof $type, 'Tipo de rechazo inesperado: '.get_class($e).' '.$e->getMessage()); return; }
    throw new RuntimeException('El archivo debió rechazarse.');
}
$fake = new class implements Scanner {
    public int $calls = 0;
    public function assertClean(string $path): void { $this->calls++; expect(is_file($path)); }
};
$gate = new ImageGate($quarantine,$fake);
$image = imagecreatetruecolor(3,2); imagefill($image,0,0,imagecolorallocate($image,20,80,160));
$samples=[];
foreach (['png','jpeg','webp'] as $format) { ob_start(); ('image'.$format)($image); $samples[$format]=ob_get_clean(); }
imagedestroy($image);
foreach ($samples as $format=>$bytes) check('decode-normalize-'.$format, function () use ($gate,$format,$bytes,$quarantine) {
    $out=$gate->prepare('synthetic.'.$format,$bytes);
    expect($out['mime']==='image/png' && $out['width']===3 && $out['height']===2);
    expect($out['sha256']===hash('sha256',$out['content']));
    expect(count(glob($quarantine.'/*'))===0,'Cuarentena no vacía');
});
// Four asymmetric quadrants allow rotation AND reflection to be checked independently of implementation.
$quadrants=imagecreatetruecolor(80,40);
foreach([[0,0,39,19,0xff0000],[40,0,79,19,0x00ff00],[0,20,39,39,0x0000ff],[40,20,79,39,0xffff00]]as $r)imagefilledrectangle($quadrants,...$r);
ob_start();imagejpeg($quadrants,null,100);$jpeg=ob_get_clean();imagedestroy($quadrants);
$oriented=function(int $orientation,bool $little=true)use($jpeg):string{
    $tiff=$little?"II\x2a\x00".pack('V',8).pack('v',1).pack('vvVv',0x112,3,1,$orientation)."\0\0".pack('V',0):"MM\x00\x2a".pack('N',8).pack('n',1).pack('nnNn',0x112,3,1,$orientation)."\0\0".pack('N',0);
    $app="Exif\0\0".$tiff;
    return substr($jpeg,0,2)."\xff\xe1".pack('n',strlen($app)+2).$app.substr($jpeg,2);
};
$orders=[1=>[0,1,2,3],2=>[1,0,3,2],3=>[3,2,1,0],4=>[2,3,0,1],5=>[0,2,1,3],6=>[2,0,3,1],7=>[3,1,2,0],8=>[1,3,0,2]];
foreach($orders as $orientation=>$order)foreach([true,false]as $little)check('jpeg-orientation-'.$orientation.'-'.($little?'little':'big'),function()use($gate,$oriented,$orientation,$order,$little,$fake){
    $before=$fake->calls;$out=$gate->prepare('camera.jpg',$oriented($orientation,$little));
    expect($fake->calls===$before+2,'Both scanner passes required');
    expect($out['width']===($orientation>=5?40:80)&&$out['height']===($orientation>=5?80:40));
    expect(!str_contains($out['content'],"Exif\0\0"),'Metadata retained');
    $decoded=imagecreatefromstring($out['content']);$w=imagesx($decoded);$h=imagesy($decoded);
    $palette=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]];
    foreach([[.25,.25],[.75,.25],[.25,.75],[.75,.75]]as $i=>[$x,$y]){
        $color=imagecolorat($decoded,(int)($w*$x),(int)($h*$y));$actual=[($color>>16)&255,($color>>8)&255,$color&255];
        foreach($actual as $channel=>$value)expect(abs($value-$palette[$order[$i]][$channel])<12,'Unexpected oriented pixel');
    }
    imagedestroy($decoded);
});
check('jpeg-invalid-orientation-keeps-original-dimensions',function()use($gate,$oriented){$out=$gate->prepare('camera.jpg',$oriented(9));expect($out['width']===80&&$out['height']===40);});
check('reject-mismatched-extension',fn()=>rejects(fn()=>$gate->prepare('photo.jpg',$samples['png']),ImageRejected::class));
check('reject-svg',fn()=>rejects(fn()=>$gate->prepare('photo.svg','<svg/>'),ImageRejected::class));
check('reject-script-disguised-as-image',fn()=>rejects(fn()=>$gate->prepare('photo.png','<?php echo 1;'),ImageRejected::class));
check('reject-oversize',fn()=>rejects(fn()=>$gate->prepare('photo.png',str_repeat('x',ImageGate::MAX_BYTES+1)),ImageRejected::class));
check('reject-path-in-name',fn()=>rejects(fn()=>$gate->prepare('../photo.png',$samples['png']),ImageRejected::class));
check('reject-empty-file',fn()=>rejects(fn()=>$gate->prepare('photo.png',''),ImageRejected::class));
check('reject-excessive-dimensions',function()use($gate,$samples){
    $bytes=$samples['png']; $bytes=substr_replace($bytes,pack('NN',10000,10000),16,8);
    $bytes=substr_replace($bytes,pack('N',crc32(substr($bytes,12,17))),29,4);
    rejects(fn()=>$gate->prepare('photo.png',$bytes),ImageRejected::class);
});
check('reject-damaged-png',fn()=>rejects(fn()=>$gate->prepare('photo.png',substr($samples['png'],0,40)),ImageRejected::class));
check('remove-appended-content',function()use($gate,$samples){$out=$gate->prepare('photo.png',$samples['png'].'SRD-UNTRUSTED-TRAILER');expect(!str_contains($out['content'],'SRD-UNTRUSTED-TRAILER'));});
check('scanner-unavailable-cleans-quarantine',function()use($quarantine,$samples){
    $scanner=new class implements Scanner {public function assertClean(string $path):void{throw new ScannerUnavailable('Prueba de fallo');}};
    rejects(fn()=>(new ImageGate($quarantine,$scanner))->prepare('photo.png',$samples['png']),ScannerUnavailable::class);
    expect(glob($quarantine.'/*')===[]);
});
check('malware-rejection-cleans-quarantine',function()use($quarantine,$samples){
    $scanner=new class implements Scanner {public function assertClean(string $path):void{throw new ImageRejected('Prueba de rechazo');}};
    rejects(fn()=>(new ImageGate($quarantine,$scanner))->prepare('photo.png',$samples['png']),ImageRejected::class);
    expect(glob($quarantine.'/*')===[]);
});
check('normalized-file-also-requires-clean-verdict',function()use($quarantine,$samples){
    $scanner=new class implements Scanner {private int $calls=0;public function assertClean(string $path):void{if(++$this->calls===2)throw new ScannerUnavailable('Segundo análisis fallido');}};
    rejects(fn()=>(new ImageGate($quarantine,$scanner))->prepare('photo.png',$samples['png']),ScannerUnavailable::class);expect(glob($quarantine.'/*')===[]);
});
$address=getenv('SRD_CLAMD_ADDRESS');
$scannerVersion=null;
if ($address) {
    $socket=@stream_socket_client($address,$errno,$error,3);
    if($socket){stream_set_timeout($socket,5);fwrite($socket,"zVERSION\0");$scannerVersion=stream_get_line($socket,512,"\0");fclose($socket);}
    $real=new ClamdScanner($address,30);
    check('real-clamd-clean-image',fn()=>expect((new ImageGate($quarantine,$real))->prepare('photo.png',$samples['png'])['width']===3));
    check('real-clamd-rejects-standard-eicar',function()use($quarantine,$real){
        // Standard harmless antivirus test marker; assembled only in temporary quarantine.
        $marker='X5O!P%@AP[4'.'\\PZX54(P^)7CC)7}$'.'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
        // Keep the harmless AV marker inside the disposable Linux container, not on a host mount.
        $path=sys_get_temp_dir().'/srd-eicar-'.bin2hex(random_bytes(12)).'.pending';
        try { file_put_contents($path,$marker); rejects(fn()=>$real->assertClean($path),ImageRejected::class); }
        finally { if(is_file($path)) unlink($path); }
        expect(glob($quarantine.'/*')===[]);
    });
}
expect(glob($quarantine.'/*')===[],'No se retiraron los archivos temporales');
rmdir($quarantine);
$report=['real_scanner_requested'=>(bool)$address,'scanner_version'=>$scannerVersion,'passed'=>count(array_filter($results,fn($r)=>$r['passed'])),'failed'=>count(array_filter($results,fn($r)=>!$r['passed'])),'cases'=>$results];
file_put_contents($base.'/results.json',json_encode($report,JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE));
echo json_encode($report,JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE).PHP_EOL;
exit($report['failed'] ? 1 : 0);
