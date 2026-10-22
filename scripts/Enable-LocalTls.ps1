param([switch]$SkipStart)
$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot

$SrdLocal=Join-Path $SrdRoot '.local'
$SrdTlsDir=Join-Path $SrdLocal 'tls'
$SrdRootAbsolute=[System.IO.Path]::GetFullPath($SrdRoot).TrimEnd('\','/')
$SrdTlsAbsolute=[System.IO.Path]::GetFullPath($SrdTlsDir)
if(-not $SrdTlsAbsolute.StartsWith($SrdRootAbsolute+[System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'La carpeta TLS debe permanecer dentro de SRD.'
}
foreach($SrdPath in @($SrdLocal,$SrdTlsDir)) {
    if((Test-Path -LiteralPath $SrdPath) -and ((Get-Item -LiteralPath $SrdPath).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'No se admiten enlaces simbólicos en la carpeta TLS.'
    }
}

docker info *> $null
if($LASTEXITCODE) { throw 'Inicia Docker Desktop antes de habilitar HTTPS local.' }
New-Item -ItemType Directory -Path $SrdTlsDir -Force | Out-Null
$SrdKey=Join-Path $SrdTlsDir 'localhost.key'
$SrdCertificate=Join-Path $SrdTlsDir 'localhost.crt'
if((Test-Path -LiteralPath $SrdKey) -xor (Test-Path -LiteralPath $SrdCertificate)) {
    throw 'El certificado local está incompleto; revísalo dentro de .local/tls.'
}
if(-not (Test-Path -LiteralPath $SrdKey)) {
    docker image inspect srd-chat:latest *> $null
    if($LASTEXITCODE) { throw 'Primero ejecuta scripts/Up.ps1 para construir la imagen local de Chat.' }
    docker run --rm --user root --mount "type=bind,source=$SrdTlsAbsolute,target=/tls" --entrypoint openssl srd-chat:latest `
        req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes `
        -keyout /tls/localhost.key -out /tls/localhost.crt -subj '/CN=localhost' `
        -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' `
        -addext 'basicConstraints=critical,CA:FALSE' `
        -addext 'extendedKeyUsage=serverAuth'
    if($LASTEXITCODE -or -not (Test-Path -LiteralPath $SrdKey) -or -not (Test-Path -LiteralPath $SrdCertificate)) {
        throw 'No se pudo generar el certificado de desarrollo.'
    }
}

if(-not $SkipStart) {
    docker compose --profile tls up -d --no-build --wait web-tls
    if($LASTEXITCODE) { throw 'No se pudo iniciar la entrada HTTPS local.' }
    Write-Host 'HTTPS local: https://localhost:8443 (certificado de desarrollo no confiable por defecto).'
}
