param([switch]$Check)

$ErrorActionPreference = 'Stop'

$signingOriginalLocation = Get-Location
$signingRepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$signingMobilePath = Join-Path $signingRepoRoot 'apps/mobile'
$signingRunnerPath = Join-Path $PSScriptRoot 'run-pnpm.ps1'
$signingStorePath = Join-Path $signingRepoRoot '.pnpm-store'
$signingCachePath = Join-Path $signingRepoRoot 'tmp/eas-cli-cache'
$signingEasArguments = @(
    "--config.store-dir=$signingStorePath"
    "--config.cache-dir=$signingCachePath"
    '--config.offline=true'
    'dlx'
    'eas-cli@24.8.0'
)

try {
    Set-Location -LiteralPath $signingMobilePath

    if ($Check) {
        & $signingRunnerPath @signingEasArguments device:create --help
        if ($LASTEXITCODE -ne 0) {
            throw "Signing tool check stopped with exit code $LASTEXITCODE."
        }
        Write-Host 'Signing tool check passed.'
        return
    }

    Write-Host 'Register your iPhone for the LocalLab preview build.'
    Write-Host 'Enter your Apple ID, password and two-factor verification code directly in this terminal.'
    Write-Host 'Select your Apple Developer team, then choose Website.'
    Write-Host 'Open the registration URL on your iPhone and complete the profile registration instructions.'
    Write-Host 'Return here and finish the device registration prompts before continuing.'
    Write-Host ''

    & $signingRunnerPath @signingEasArguments device:create
    $signingDeviceExitCode = $LASTEXITCODE
    if ($signingDeviceExitCode -ne 0) {
        throw "Device registration stopped with exit code $signingDeviceExitCode."
    }

    Write-Host ''
    Write-Host 'Configure the iOS signing credentials for the preview profile.'
    Write-Host 'Complete any Apple sign-in and verification prompts directly in this terminal.'
    Write-Host 'Include your registered iPhone when selecting devices for the provisioning profile.'
    Write-Host ''

    & $signingRunnerPath @signingEasArguments credentials:configure-build --platform ios --profile preview
    $signingCredentialsExitCode = $LASTEXITCODE
    if ($signingCredentialsExitCode -ne 0) {
        throw "Signing setup stopped with exit code $signingCredentialsExitCode."
    }

    $signingMarkerDirectory = Join-Path $signingRepoRoot 'tmp/iphone-deploy'
    $signingMarkerPath = Join-Path $signingMarkerDirectory 'signing-ready.json'
    New-Item -ItemType Directory -Path $signingMarkerDirectory -Force | Out-Null
    $signingMarkerJson = @{ readyAtUtc = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($signingMarkerPath, $signingMarkerJson, [System.Text.UTF8Encoding]::new($false))

    Write-Host ''
    Write-Host 'Device registration and signing setup completed. No build was submitted.'
} finally {
    Set-Location -LiteralPath $signingOriginalLocation.Path
}
