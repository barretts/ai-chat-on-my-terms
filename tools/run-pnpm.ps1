# Windows environments can contain both PATH and Path. Keep one process-local
# entry so pnpm and its child processes agree on the local executable search path.
$ErrorActionPreference = 'Stop'
$runnerPathValue = $env:PATH
if ([string]::IsNullOrWhiteSpace($runnerPathValue)) {
    throw 'The current process has no executable search path.'
}
[Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
[Environment]::SetEnvironmentVariable('Path', $null, 'Process')
[Environment]::SetEnvironmentVariable('PATH', $runnerPathValue, 'Process')
& pnpm @args
exit $LASTEXITCODE
