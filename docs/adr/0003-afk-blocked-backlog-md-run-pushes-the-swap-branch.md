# For Backlog.md a blocked AFK run pushes a branch that holds only the label swap

A Backlog.md task has no state outside the repository, so the swap from the AFK label to `afk-blocked` and the reason have to be a commit. That commit cannot go on the base branch, which an AFK run never writes to, so it goes on the run's own branch `afk/<id>`, and the run pushes that branch. The branch is the claim, so the task is not retried. To retry it, a human deletes the `afk/<id>` branch on the remote; the task on the base branch still carries the AFK label, so the next daemon pass picks it up again. The alternative of leaving the branch unpushed would lose the reason and let the daemon retry the same failing task in a loop.

## Consequences

- The Backlog.md backlog edits and commits in the run's checkout (`ctx.workdir`, on branch `afk/<id>`) and never pushes; refusing any other branch keeps it off the base branch. The run (#7) pushes, for a finished run and for a blocked one.
- A blocked run pushes no work. On GitHub that means no branch at all; for Backlog.md it means a branch with one commit that swaps the label and records the reason in the task file.
- Tasks are read from the base branch fetched from the remote, so the swap becomes visible to the daemon only if a human merges or cherry-picks it, which is intended: the claim branch already keeps the task out of the ready list.
