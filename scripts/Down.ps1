$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
docker compose down
if($LASTEXITCODE) { throw 'No se pudo detener Compose.' }
# No --volumes: preserve databases and sessions.
