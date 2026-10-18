# Windows runner repair — 2026-09-26

## Setup failure

Normal shell commands failed before launch with `helper_unknown_error: setup refresh had errors`.
The local sandbox log identified an ACL update failure opening the workspace `.git` directory.
Its owner was the sandbox account, whereas the workspace owner was the signed-in user.

A bounded elevated repair changed only the `.git` directory owner to the workspace owner.
The script rejected reparse points, backed up the security descriptor, and compared the access
rules before and after. It did not recurse. The result reported success and identical access rules.
The raw backup and result remain in the ignored `tmp/runner-repair/` directory.

After repair, normal sandbox commands launch successfully, and sandbox setup reports `errors=[]`.
`Get-Location`, Node 24.13.1, pnpm 8.15.9, and Git status all work.

## Command lookup

The shell inherited both `PATH` and `Path`. pnpm added its local bins to one entry while its
child process used the other. This made `pnpm exec prettier` fail even though its shim existed.
Removing both entries and restoring one entry in the current process made the same command pass.

`tools/run-pnpm.ps1` applies this process-local normalization and forwards all arguments and the
exit code. It does not change user or machine environment variables.

```powershell
& ./tools/run-pnpm.ps1 exec prettier --version
& ./tools/run-pnpm.ps1 test:chat-composition
```

The composition suite passed 20/20 tests through this normalized path. Full workspace typecheck
passed for all 49 configured projects, and full Prettier checking passed.

## Test launcher user lookup

After the shell repair, `tsx` still failed before starting tests with `uv_os_get_passwd ENOMEM`.
The sandbox account has no Windows profile metadata. A direct Windows profile API probe reported
`FILE_NOT_FOUND`, whereas the signed-in user's profile probe succeeded. Node's `os.userInfo()`
therefore failed in the sandbox; this was not evidence of exhausted memory.

tsx 4.16.2 calls `os.userInfo()` to choose a cache/IPC temporary directory. The tracked
`patches/tsx@4.16.2.patch` catches only this Windows system lookup failure, creates a private
random temporary directory, and shares that directory with child processes and loader workers.
Healthy user lookup behavior and unrelated errors remain unchanged. The root manifest and
pnpm lock register the patch; reinstalling dependencies preserves the fix.

Verification in the normal sandbox: chat integration 10/10 and lifecycle 4/4 passed. A separate
direct `node --import tsx --test` integration check also passed. The targeted smoke confirmed matching
ESM/CJS/child directories, original healthy Windows behavior, simulated Linux behavior in a fixture
on Windows, and rethrowing unrelated errors.
The sandbox account, user profile registry, machine environment, and global Node APIs were not changed.
