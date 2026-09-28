[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$taskRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOutput = Join-Path $taskRepoRoot 'tmp/messenger-redesign'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskZipPath = Join-Path $taskOutput ('LocalLab-Mac-source-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
Push-Location -LiteralPath $taskRepoRoot
try {
    $taskFiles = @(rg --files --hidden -g '!**/node_modules/**' -g '!.git/**' -g '!tmp/**' -g '!.codex/**' -g '!.agents/**' -g '!**/.next/**' -g '!**/out/**' -g '!**/.env*' |
        Where-Object { $_ -match '^(apps|packages|modules|services|workers|infra|tests|docs|plans|patches|tools|\.github)[\\/]' -or $_ -in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json','README.md','.gitignore','.npmrc','.prettierignore') })
    if ($LASTEXITCODE -ne 0 -or -not $taskFiles.Count) { throw 'Could not enumerate source files.' }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $taskArchive = [IO.Compression.ZipFile]::Open($taskZipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($taskFile in $taskFiles) {
            $taskFullPath = [IO.Path]::GetFullPath((Join-Path $taskRepoRoot $taskFile))
            if (-not $taskFullPath.StartsWith($taskRepoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source path escaped the checkout.' }
            $taskEntryPath = 'LocalLab/' + $taskFile.Replace('\', '/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskArchive, $taskFullPath, $taskEntryPath, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $taskArchive.Dispose() }
    [pscustomobject]@{ Path=$taskZipPath; Files=$taskFiles.Count; Bytes=(Get-Item -LiteralPath $taskZipPath).Length } | ConvertTo-Json
} finally { Pop-Location }
