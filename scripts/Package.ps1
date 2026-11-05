param([ValidatePattern('^SRD-[A-Za-z0-9._-]+[.]zip$')][string]$OutputName='SRD-0.1-source.zip')
$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
node tools/package.mjs
if($LASTEXITCODE){throw 'No se pudo preparar la lista del paquete.'}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$SrdTarget=Join-Path (Join-Path $SrdRoot 'dist') $OutputName
$SrdStream=[IO.File]::Open($SrdTarget,[IO.FileMode]::Create)
$SrdZip=New-Object IO.Compression.ZipArchive($SrdStream,[IO.Compression.ZipArchiveMode]::Create)
try {
    foreach($SrdRelative in (Get-Content -Raw -LiteralPath (Join-Path $SrdRoot '.local/package-files.json') | ConvertFrom-Json)) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($SrdZip,(Join-Path $SrdRoot $SrdRelative),"SRD/$SrdRelative",[IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {$SrdZip.Dispose(); $SrdStream.Dispose()}
$SrdHash=(Get-FileHash -LiteralPath $SrdTarget -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$SrdTarget.sha256","$SrdHash  $OutputName`n")
Write-Host "Paquete generado: $SrdTarget"
