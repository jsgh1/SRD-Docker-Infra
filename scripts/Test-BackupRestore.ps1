param([string]$Backup,[switch]$VerifyOnly)
$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
$SrdOperation=if($VerifyOnly){'verify'}else{'restore-test'}
if($Backup){node tools/backup-local.mjs $SrdOperation $Backup}else{node tools/backup-local.mjs $SrdOperation}
if($LASTEXITCODE){throw 'No se completo la verificacion del respaldo.'}
