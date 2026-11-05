<?php
// Synthetic test packages only; output stays within SRD/.local.
$root=dirname(__DIR__).'/.local';if(!is_dir($root))mkdir($root,0700,true);
foreach(['docx','xlsx'] as $ext){
 $prefix=$ext==='docx'?'word/document':'xl/workbook';$mime=$ext==='docx'?'wordprocessingml.document':'spreadsheetml.sheet';
 $z=new ZipArchive;$z->open($root.'/office-fixture.'.$ext,ZipArchive::CREATE|ZipArchive::OVERWRITE);
 $types='<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/'.$prefix.'.xml" ContentType="application/vnd.openxmlformats-officedocument.'.$mime.'.main+xml"/>';
 if($ext==='xlsx')$types.='<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
 $z->addFromString('[Content_Types].xml',$types.'</Types>');
 $z->addFromString('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="'.$prefix.'.xml"/></Relationships>');
 if($ext==='docx')$z->addFromString('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Documento sintético SRD</w:t></w:r></w:p></w:body></w:document>');
 else{
  $z->addFromString('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Prueba" sheetId="1" r:id="r1"/><sheet name="Anexo" sheetId="2" r:id="r2"/></sheets></workbook>');
  $z->addFromString('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>');
  $z->addFromString('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SRD sintético</t></is></c></row></sheetData></worksheet>');
  $z->addFromString('xl/worksheets/sheet2.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Anexo privado</t></is></c></row></sheetData></worksheet>');
 }
 $z->close();
}
echo "Synthetic Office fixtures created inside SRD/.local\n";
