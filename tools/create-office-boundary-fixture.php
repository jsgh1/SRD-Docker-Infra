<?php
// Passive synthetic DOCX with three linked PNGs, no source documents or user data.
$directory=dirname(__DIR__).'/.local';
if(!is_dir($directory))mkdir($directory,0700,true);
$path=$directory.'/office-boundary.docx';$over=$directory.'/office-over-limit.docx';
function chunk(string $type,string $data):string{return pack('N',strlen($data)).$type.$data.pack('H*',hash('crc32b',$type.$data));}
function image(int $padding):string {
 $width=1280;$height=1800;$row='';$seed=unpack('C3',random_bytes(3));
 for($x=0;$x<$width;$x++)$row.=pack('CCC',($x+$seed[1])%256,($x*7+$seed[2])%256,($x*13+$seed[3])%256);
 return "\x89PNG\r\n\x1a\n".chunk('IHDR',pack('NNCCCCC',$width,$height,8,2,0,0,0))
  .chunk('tEXt',"SRD\0".str_repeat('A',$padding)).chunk('IDAT',gzcompress(str_repeat("\0".$row,$height),0)).chunk('IEND','');
}
$word='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
$relations='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
$body='<w:p><w:r><w:t>SRD synthetic run '.bin2hex(random_bytes(16)).'</w:t></w:r></w:p>';$links='';
for($i=1;$i<=3;$i++){
 $body.='<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="'.$i.'" name="Synthetic '.$i.'"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="'.$i.'" name="Synthetic '.$i.'"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="image'.$i.'"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
 $links.='<Relationship Id="image'.$i.'" Type="'.$relations.'/image" Target="media/image'.$i.'.png"/>';
}
$parts=[
 '[Content_Types].xml'=>'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
 '_rels/.rels'=>'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="'.$relations.'/officeDocument" Target="word/document.xml"/></Relationships>',
 'word/document.xml'=>'<w:document xmlns:w="'.$word.'" xmlns:r="'.$relations.'" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>'.$body.'<w:sectPr/></w:body></w:document>',
 'word/_rels/document.xml.rels'=>'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'.$links.'</Relationships>'
];
function archive(string $path,array $parts,int $padding):void {
 $zip=new ZipArchive;if($zip->open($path,ZipArchive::CREATE|ZipArchive::OVERWRITE)!==true)throw new RuntimeException('Cannot create boundary fixture');
 for($i=1;$i<=3;$i++)$parts['word/media/image'.$i.'.png']=image($i===1?$padding:0);
 foreach($parts as $name=>$content){if(strlen($content)>8*1024*1024)throw new RuntimeException('Part limit exceeded');$zip->addFromString($name,$content);$zip->setCompressionName($name,ZipArchive::CM_STORE);}
 if(!$zip->close())throw new RuntimeException('Cannot finish boundary fixture');
}
archive($path,$parts,0);clearstatcache(true,$path);$padding=20*1024*1024-filesize($path);
if($padding<0)throw new RuntimeException('Fixture is too large');
archive($path,$parts,$padding);clearstatcache(true,$path);
if(filesize($path)!==20*1024*1024)throw new RuntimeException('Boundary fixture size mismatch');
if(!copy($path,$over))throw new RuntimeException('Cannot create over-limit fixture');
$zip=new ZipArchive;if($zip->open($over,ZipArchive::CHECKCONS)!==true)throw new RuntimeException('Invalid over-limit archive');
$zip->setArchiveComment('x');$zip->close();clearstatcache(true,$over);
if(filesize($over)!==20*1024*1024+1)throw new RuntimeException('Over-limit fixture size mismatch');
echo json_encode(['boundary_bytes'=>filesize($path),'over_limit_bytes'=>filesize($over),'sha256'=>hash_file('sha256',$path)],JSON_THROW_ON_ERROR)."\n";
