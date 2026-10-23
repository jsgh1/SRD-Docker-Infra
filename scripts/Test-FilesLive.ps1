$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
$SrdOutput=Get-Content -Raw -LiteralPath tools/check-files-live.php | docker compose exec -T files php
if($LASTEXITCODE){throw 'Falló la integración real de fotografías.'}
$SrdReport=($SrdOutput -join "`n").Trim([char]0xFEFF).Trim() | ConvertFrom-Json
if($SrdReport.passed -ne $true){throw 'La prueba no confirmó un resultado satisfactorio.'}
New-Item -ItemType Directory -Force -Path '.local' | Out-Null
[IO.File]::WriteAllText((Join-Path $SrdRoot '.local/files-live-results.json'),($SrdReport | ConvertTo-Json -Depth 5))
$SrdReport | ConvertTo-Json -Depth 5
