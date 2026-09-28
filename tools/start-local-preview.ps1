param(
    [ValidateRange(1024, 65535)][int]$Port = 8081,
    [string[]]$ProviderOrigin = @(),
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$previewRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$previewRunnerPath = Join-Path $PSScriptRoot 'run-pnpm.ps1'
$previewLogDirectory = Join-Path $previewRepoRoot ('tmp/local-preview/' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path $previewLogDirectory -Force | Out-Null
$previewShellPath = (Get-Command powershell.exe).Source
$previewDesiredOrigins = @()
foreach ($previewOrigin in $ProviderOrigin) {
    $previewProviderUrl = [uri]$previewOrigin
    if ($previewProviderUrl.Scheme -notin @('http', 'https') -or $previewProviderUrl.UserInfo -or $previewProviderUrl.Query -or $previewProviderUrl.Fragment -or $previewProviderUrl.AbsolutePath -ne '/') {
        throw 'ProviderOrigin must contain only the HTTP(S) scheme, host, and port.'
    }
    $previewDesiredOrigins += $previewProviderUrl.GetLeftPart([UriPartial]::Authority)
}
$previewDesiredOrigins = @($previewDesiredOrigins | Select-Object -Unique)
$previewUrl = "http://localhost:$Port"
$previewExistingListeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($previewExistingListeners.Count) {
    $previewExistingId = $previewExistingListeners[0].OwningProcess
    $previewExistingProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $previewExistingId)
    if ($previewExistingProcess.CommandLine -notmatch [regex]::Escape((Join-Path $previewRepoRoot 'apps/mobile')) -or $previewExistingProcess.CommandLine -notmatch ('--port["\s]+' + $Port)) {
        throw "Port $Port is already used by a different process. Choose another -Port."
    }
    $previewExistingConfig = Invoke-RestMethod -Uri "$previewUrl/_locallab/preview-config" -TimeoutSec 5
    if (-not $ProviderOrigin.Count -and $previewExistingConfig.providerOrigins.Count) {
        $previewDesiredOrigins = @($previewExistingConfig.providerOrigins)
    }
    if (-not $Restart) {
        if (@($previewDesiredOrigins | Where-Object { $_ -notin $previewExistingConfig.providerOrigins }).Count) {
            throw 'The preview is running with a different provider. Run this command with -Restart to apply ProviderOrigin.'
        }
        [pscustomobject]@{ ServerProcessId = $previewExistingId; Url = $previewUrl; Reused = $true }
        return
    }
    Stop-Process -Id $previewExistingId -Force
}
$env:LOCALLAB_LOCAL_PROVIDER_ORIGINS = if ($previewDesiredOrigins.Count) { $previewDesiredOrigins -join ',' } else { $null }
$previewArguments = @(
    '-NoProfile', '-File', ('"{0}"' -f $previewRunnerPath),
    '--filter', '@locallab/mobile', 'exec', 'expo', 'start',
    '--localhost', '--port', [string]$Port, '--no-dev'
)
$previewProcess = Start-Process -FilePath $previewShellPath -ArgumentList $previewArguments -WorkingDirectory $previewRepoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $previewLogDirectory 'server.log') -RedirectStandardError (Join-Path $previewLogDirectory 'server-error.log') -PassThru
$previewDeadline = [DateTime]::UtcNow.AddSeconds(45)
do {
    if ($previewProcess.HasExited) {
        $previewError = Get-Content (Join-Path $previewLogDirectory 'server-error.log') -Raw -ErrorAction SilentlyContinue
        throw "The local preview stopped during startup. $previewError"
    }
    try {
        $previewReadyConfig = Invoke-RestMethod -Uri "$previewUrl/_locallab/preview-config" -TimeoutSec 2
        if (-not @($previewDesiredOrigins | Where-Object { $_ -notin $previewReadyConfig.providerOrigins }).Count) {
            $previewServerId = (Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -First 1).OwningProcess
            [pscustomobject]@{ ProcessId = $previewProcess.Id; ServerProcessId = $previewServerId; Url = $previewUrl; LogDirectory = $previewLogDirectory; Reused = $false }
            return
        }
    } catch { }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $previewDeadline)
throw "The preview has not become ready. Check logs in $previewLogDirectory. The startup process is still running (PID $($previewProcess.Id))."
