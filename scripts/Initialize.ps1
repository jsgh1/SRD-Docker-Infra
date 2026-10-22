$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
node tools/initialize.mjs
if($LASTEXITCODE) { throw 'No se pudo generar la configuración.' }
