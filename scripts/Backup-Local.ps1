$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
node tools/backup-local.mjs create
if($LASTEXITCODE){throw 'No se completo el respaldo local.'}
