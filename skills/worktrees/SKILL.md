---
name: worktrees
description: Triage, merge, and prune git worktrees created by background/AFK agents in the current repo. Use when the user asks "any open worktrees?", "look at the worktrees", "merge the done ones", "prune/delete worktrees", or wants to sweep WIP branches and close their issues.
---

# Worktrees

Sweep the repo's worktrees by working out which finished their issue, merging those to the default branch and closing the issue, and pruning everything else. This is a recurring chore, because background agents spawn worktrees, often named `<topic>-<timestamp>` or `<repo>-issue-<n>`, and most sessions end with the user wanting them cleaned up.

Setup, done once at the start, is to detect the default branch (`git symbolic-ref refs/remotes/origin/HEAD --short`, referred to below as `<main>`) and the toolchain (`pyproject.toml`/`uv.lock`, `package.json`, `Cargo.toml`, …). Requires an authenticated `gh`. Run from repo root.

## Phase 1: Inventory

```
git worktree list
```

For each worktree (skip the main checkout):
- Map it to a GitHub issue. The trailing timestamp/topic usually hints the issue; confirm with the branch name and `gh issue list`.
- Get its state vs `<main>`:
  - `git -C <wt> log --oneline <main>..HEAD` (commits ahead)
  - `git -C <wt> diff --stat <main>...HEAD` (size of work)
  - `git -C <wt> status --porcelain` (uncommitted/dirty?)

Classify each as **done** (issue implemented, committed), **WIP** (partial commits, not finished) or **empty** (no real diff). Report the table before acting.

## Phase 2: Verify the "done" ones

Before merging, prove it works:
- Run the repo's verify command (the `## Verify` heading in its `AGENTS.md`) when it has one; otherwise run the **fast** tests only, with the repo's toolchain (e.g. `uv run pytest --ignore=tests/ui`, `npm test`), and deselect slow UI/end-to-end/journey dirs, since those are slow and the user repeatedly says to skip/stop them.
- If the user explicitly asked, run UI tests too, but they hang or are slow, so if one stalls, stop it rather than blocking.
- Dispatch a `reviewer` (Claude Code: the `reviewer` agent, model `opus`) with the range `<main>...<branch>` and the issue text as the spec. Merge on `VERDICT: CLEAN` or `PASS WITH NOTES`; on `NEEDS FIXES` leave the branch unmerged and report the findings. Green tests alone are not a reason to merge.

## Phase 3: Merge done work

Merge to `<main>` **without losing changes already on `<main>`**:
1. From repo root on `<main>`, run `git pull` or otherwise ensure it is up to date.
2. Merge the worktree branch: `git merge <branch>`, and resolve conflicts in favor of keeping both `<main>`'s recent work and the worktree's feature. If the worktree is behind `<main>`, rebase or merge `<main>` into it first so nothing is dropped.
3. Re-run the fast tests after merge if conflicts were resolved.
4. Close the issue with `gh issue close <n> -c "Merged via <branch>"`.

## Phase 4: Prune

```
git worktree remove <path>          # done & merged, or WIP/empty being discarded
git worktree prune
git branch -d <branch>              # -D only if discarding unmerged WIP the user OK'd
```

On Windows checkouts, a `.venv/lib64` symlink can cause a permission error during `git worktree remove`. Work around it with `git worktree remove --force <path>`, or delete the `.venv` inside the worktree first, then remove.

Also on Windows checkouts, deleting agent-created worktrees can fail with `Filename too long`. Ensure `git config core.longpaths true` is set in the repo, then retry with `git worktree remove --force <path>`.

## Policy

- A **done** worktree is verified, reviewed, merged, its issue closed, and then pruned.
- A **WIP** worktree is NOT merged unless the user says so, and is pruned only on user confirmation (work is lost).
- An **empty** worktree is safe to prune.
- A "None"/stale worktree entry is handled with `git worktree prune`.

## Confirm before destroying

Pruning a WIP worktree and deleting its unmerged branch is irreversible. List exactly what will be removed and what work is lost, and get explicit OK before removing anything not yet merged. Merge to `<main>` only when the user asked for the merge ("merge the done ones" is that approval; a triage request alone is not), and then once tests pass and the issue is satisfied. Pushing needs its own approval.
