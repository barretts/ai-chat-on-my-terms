# OMP workflow for this repository

These instructions apply to OMP work in `C:\code\cht`.

## Ordered tasks and session recovery

- Before editing, inspect `git status` and preserve all pre-existing changes. For a long or ordered task, keep one concise progress record with the current item, completed items and commit IDs, files changed, checks actually run, known gaps, and the next item.
- On resume, read that progress record and inspect `git status` plus recent commits first. Reconcile disagreements between the record, commit history, and working tree before continuing. Do not reread the full history unless a specific question requires it.
- Follow the user's requested order and stopping points. When asked to stop, leave a concise checkpoint. On resume, continue from that checkpoint and report any state mismatch.
- Keep verified, committed work distinct from in-progress or unverified changes. Never mark a fix complete or commit it based only on intent or a passing check from another state.

## Scoped edits and commits

- Before each commit, inspect the exact diff and stage only files belonging to that task. Avoid `git add -A` when unrelated or pre-existing changes may exist.
- Do not use broad restore, checkout, reset, or stash operations without confirming their exact path and effect on the current working tree. After a stash-based check, verify the stash was restored and the worktree matches the expected state before proceeding.
- If a command fails, stop that command chain, inspect the repository state, and recover before continuing. Never assume a later command ran in the intended directory.

## Verification and reporting

- Run the checks required by the task or fix plan. Report exact results and distinguish checks that passed from native, platform, integration, or cross-language checks that could not run.
- For each completed item in a multi-item task, record its identifier, files changed, verification performed, commit ID, and any remaining gap. Keep the next action explicit and brief.
