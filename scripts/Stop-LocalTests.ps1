$ErrorActionPreference = 'Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
$SrdPidFile=Join-Path $SrdRoot '.local/processes.json'
if (!(Test-Path -LiteralPath $SrdPidFile)) { return }
foreach($SrdEntry in (Get-Content -Raw -LiteralPath $SrdPidFile | ConvertFrom-Json)) {
    $SrdProcess=Get-Process -Id $SrdEntry.id -ErrorAction SilentlyContinue
    if($SrdProcess -and $SrdProcess.StartTime.ToUniversalTime().ToString('o') -eq $SrdEntry.started) {
        Stop-Process -Id $SrdEntry.id
    }
}
