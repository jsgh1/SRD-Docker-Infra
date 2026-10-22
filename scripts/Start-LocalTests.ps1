$ErrorActionPreference = 'Stop'
$SrdRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
node tools/local-env.mjs
if ($LASTEXITCODE) { throw 'No se pudo crear el entorno local' }
$SrdProcesses = @()
$SrdServices = @('gateway','identity','configuration','records','audit')
foreach($SrdName in $SrdServices) {
    if(!(Test-Path -LiteralPath "services/$SrdName/vendor/autoload.php")) { throw "Faltan dependencias de $SrdName. Ejecuta Composer antes de iniciar." }
    php "services/$SrdName/artisan" migrate --force
    if ($LASTEXITCODE) { throw "Migración fallida: $SrdName" }
}
foreach($SrdPort in @(8100,8101,8102,8103,8104,8125,1125,5173)) {
    if(Get-NetTCPConnection -State Listen -LocalPort $SrdPort -ErrorAction SilentlyContinue) { throw "El puerto $SrdPort está ocupado; no se detendrá el proceso existente." }
}
for ($SrdIndex=0; $SrdIndex -lt $SrdServices.Length; $SrdIndex++) {
    $SrdName=$SrdServices[$SrdIndex]
    $SrdPort=8100+$SrdIndex
    $SrdProc=Start-Process -FilePath (Get-Command php.exe).Source -ArgumentList @('-S',"127.0.0.1:$SrdPort",'-t','public','public/index.php') -WorkingDirectory (Join-Path $SrdRoot "services/$SrdName") -RedirectStandardOutput (Join-Path $SrdRoot ".local/$SrdName.stdout.log") -RedirectStandardError (Join-Path $SrdRoot ".local/$SrdName.stderr.log") -WindowStyle Hidden -PassThru
    $SrdProcesses+=@{id=$SrdProc.Id;name=$SrdName;started=$SrdProc.StartTime.ToUniversalTime().ToString('o')}
    $SrdProcesses | ConvertTo-Json | Set-Content -Encoding UTF8 .local/processes.json
}
if(Test-Path -LiteralPath '.local/mailpit/mailpit.exe') {
    $SrdProc=Start-Process -FilePath (Join-Path $SrdRoot '.local/mailpit/mailpit.exe') -ArgumentList @('--listen','127.0.0.1:8125','--smtp','127.0.0.1:1125','--database',"`"$(Join-Path $SrdRoot '.local/mailpit/messages.db')`"") -WindowStyle Hidden -PassThru
    $SrdProcesses+=@{id=$SrdProc.Id;name='mailpit';started=$SrdProc.StartTime.ToUniversalTime().ToString('o')}
}
$SrdProc=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('node_modules/vite/bin/vite.js','--host','127.0.0.1') -WorkingDirectory (Join-Path $SrdRoot 'apps/web') -RedirectStandardOutput (Join-Path $SrdRoot '.local/web.stdout.log') -RedirectStandardError (Join-Path $SrdRoot '.local/web.stderr.log') -WindowStyle Hidden -PassThru
$SrdProcesses+=@{id=$SrdProc.Id;name='web';started=$SrdProc.StartTime.ToUniversalTime().ToString('o')}
$SrdProcesses | ConvertTo-Json | Set-Content -Encoding UTF8 .local/processes.json
Write-Host 'Pruebas locales: http://127.0.0.1:5173 | Mailpit: http://127.0.0.1:8125'
Write-Host 'SQLite solo para pruebas. La validación de MySQL requiere Docker Compose.'
