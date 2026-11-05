<?php
// Synthetic pixels only; no user photographs or reference-archive data.
$directory=dirname(__DIR__).'/.local';
if(!is_dir($directory))mkdir($directory,0700,true);
if(!extension_loaded('gd'))throw new RuntimeException('GD required for synthetic image');
$image=imagecreatetruecolor(4,3);
for($x=0;$x<4;$x++)for($y=0;$y<3;$y++)imagesetpixel($image,$x,$y,imagecolorallocate($image,$x*52,$y*71,90));
$path=$directory.'/folder-image.jpg';
if(!imagejpeg($image,$path,90))throw new RuntimeException('Cannot create synthetic JPEG');
imagedestroy($image);
echo json_encode(['source_bytes'=>filesize($path),'sha256'=>hash_file('sha256',$path)],JSON_THROW_ON_ERROR)."\n";
