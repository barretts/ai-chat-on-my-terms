# PowerShell environment for AI Chat on My Terms plans

> Local workstation: Windows; run every local workspace command in PowerShell.

## Host and command runner

The implementation workstation is Windows and the repository is `C:\code\cht`.
Use Windows PowerShell 5.1 compatible commands, or a newer PowerShell with the same syntax.
Prefer the client's native file/search/edit tools and `rg` for targeted searches.
A tool named **Bash** does not establish which shell executes its commands.
If that tool runs Bash, invoke `powershell.exe` explicitly for workspace commands;
do not send raw PowerShell expressions to Bash or Bash expressions to PowerShell.

For a short command without shell variables:

```powershell
powershell.exe -NoLogo -NoProfile -Command "Set-Location -LiteralPath 'C:\code\cht'; Get-Content -LiteralPath 'plans\README.md'"
```

For multiple commands, write an actual task-specific `.ps1` file with the native edit tool,
then launch it with `powershell.exe -NoLogo -NoProfile -File` and its full path.
This keeps PowerShell variables, quotes and newlines out of another shell's expansion rules.
Do not change execution policy, client model settings or the package lockfile to make a runner work.

## Workspace commands

```powershell
Set-Location -LiteralPath 'C:\code\cht'
git --no-optional-locks status --short
Get-ChildItem -LiteralPath '.\handoffs\qwen3.8-flash-next-2026-10-08'
Get-Content -LiteralPath '.\handoffs\qwen3.8-flash-next-2026-10-08\PROGRESS.md'
rg --files .\apps\mobile\composition\chat
rg -n 'resolveWebResearchPolicy' .\apps\mobile\composition\chat
```

Use `Test-Path`, `Get-Content`, `Get-ChildItem`, `Select-Object`, `Select-String`,
`Copy-Item`, `Move-Item` and `Remove-Item` where appropriate. Use `-LiteralPath`
for an exact filename. Check a computed absolute target before a move or deletion.
Keep mutations within the task's owned paths and preserve existing work.

PowerShell 5.1 does not support Bash-style `&&` or `||` chaining.
Do not use `/dev/null`, `2>/dev/null`, Bash heredocs, `export`, `grep`, `sed`,
`awk`, `head`, `tail`, `ls -la`, `rm -rf` or `mkdir -p` as workspace commands.
Run independent commands on separate lines; use `if` for conditional execution.
Avoid unnecessary directory listings when the required files are already named.

## Local checks and exit codes

After the 2026-09-26 runner repair, workspace packages install through `& ./tools/run-pnpm.ps1 <arguments>` (PowerShell 5.1 handles duplicate `PATH`/`Path` entries through this wrapper; see the [runner repair evidence](../archived/docs/implementation/evidence/runner-repair-2026-09-26.md)). Direct `pnpm` also works in terminals with a clean PATH. Retain the pinned package versions and lockfile. The direct-binary fallback below remains for environments where no package manager resolves at all. Choose the card's focused test files; these examples do not replace its acceptance criteria.

```powershell
node .\node_modules\vitest\vitest.mjs run apps/mobile/composition/chat/web-research-settings.test.mts apps/mobile/composition/chat/web-research-intent.test.mts apps/mobile/composition/chat/web-research.test.mts
$cardTestExit = $LASTEXITCODE
if ($cardTestExit -ne 0) { throw "Focused checks failed with exit code $cardTestExit" }

node .\node_modules\typescript\bin\tsc --noEmit -p .\apps\mobile
$cardTypecheckExit = $LASTEXITCODE
if ($cardTypecheckExit -ne 0) { throw "Mobile TypeScript failed with exit code $cardTypecheckExit" }
```

Capture a native command's `$LASTEXITCODE` immediately when its result controls the next action.
An `rg` exit code of **1** with no matches is a completed search, not an execution error.
Accept it and move on. An `rg` exit code of **2** indicates an error to investigate.
Record exact check commands, counts, exit codes and evidence levels in the active handoff.
Historical commands and results in status files remain historical evidence.

## Platform-specific proof

PowerShell is the local workstation shell. It does not provide an Apple native toolchain.
Mac-only Xcode, Swift/iOS builds, signing and physical iPhone checks still require the
actual named Mac/device environment. Keep commands for a remote host or a container
explicitly labeled for that environment; do not reinterpret them as local Windows commands.
Record unavailable native/service proof as pending and continue independent ready work.
A local fixture or typecheck never stands in for native compilation or a phone exercise.

## Resume and exploration

The 2026-10-08 handoff session is closed; its [progress record](../archived/handoffs/qwen3.8-flash-next-2026-10-08/PROGRESS.md)
and [queue](../archived/handoffs/qwen3.8-flash-next-2026-10-08/TASK_QUEUE.md) are archive history. Resume from current git history, the [build records](../docs/builds/) and the [remaining work ledger](status/README.md) rather than restarting bootstrap tasks.
Read one ready task card and the source it needs. Ignore `.opencode/` unless the active card owns it.
Do not reread unchanged files or repeat an identical failed command without a changed input.
If a test file is absent, use the nearest existing convention to create the test required by the card.
After two unsuccessful attempts with one approach, change approach. If no progress is possible,
record the specific blocker and continue only dependency-ready independent work.
