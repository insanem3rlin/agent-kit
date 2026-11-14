---
name: do-epic
description: "Orchestrate a whole epic (a parent GitHub issue with many interconnected subissues) from open to merged. Build the blocked-by dependency graph, run subissues in dependency order (parallel where unblocked) via the do-issue skill, have a reviewer check each result, and gate the next wave on the previous one landing. Use when the user says \"do epic #N\", \"tackle parent issue #N and everything under it\", \"implement all subissues of #N in order\"."
---

# Do Epic

Drive a parent issue and its interconnected subissues to done. You are the **orchestrator**, so you do not write feature code yourself. You build the order, dispatch [[do-issue]] subagents (the `implementer` role), have a `reviewer` check each result, and gate the next wave on the last one landing.

Setup happens once, at the start. Infer `<owner>/<repo>` from `git remote get-url origin`; detect the default branch (`git symbolic-ref refs/remotes/origin/HEAD --short`, referred to below as `<main>`). Requires an authenticated `gh`. Run from repo root. If the repo documents an issue-tracker workflow (e.g. `docs/agents/issue-tracker.md`), follow it.

## Phase 1: Map the graph

```
gh issue view <parent> --comments
```

- Collect subissues: GitHub task-list checkboxes (`- [ ] #12`) and links in the parent body, plus `gh issue list` results that reference the parent.
- For each subissue, `gh issue view <n> --comments` and record its blockers. A subissue is **blocked by** another when its body/comments say "blocked by #x", "depends on #x", "after #x", or lists it as a prerequisite task. When it's ambiguous, ask the user rather than guessing the order. **Keep the full fetched body/comments text for every subissue**. Phase 3 hands it straight to each subagent instead of making it re-fetch the same issue.
- Build the directed graph (an edge from x to y means "x blocked by y"). Detect cycles. A cycle is a spec bug, so stop and report it, don't try to run it.
- Read the repo's context docs once here too (`CLAUDE.md`/`AGENTS.md`/`CONTEXT.md`, where present), and skim any ADR folder (e.g. `docs/adr/`) for filenames. Both are the same for every subissue in this epic, and Phase 3 pastes them in rather than having every subagent read them again.

Print the graph and the resulting wave order, and get a quick confirm before dispatching. This is the one place a wrong read is expensive. Starting the epic is the user's request to take it from open to merged, so the confirm also approves, for every subissue, the commit, the push of its branch, its pull request, comments on the issue and the merge once its review is clean. Name these actions in the confirm question, so the user knows what the one answer approves.

## Phase 2: Topological waves

Sort into waves, where **wave 0** is every subissue with no open blockers, and each later wave is the issues whose blockers all landed in earlier waves. Issues within a wave are independent, so they run in parallel.

## Phase 3: Run each wave

For every issue in the current wave, dispatch **one `implementer`** (Claude Code: the `implementer` agent, model `sonnet`), in parallel across the wave, dispatching them together in a single message (Claude Code: one `Agent` call each). The review pass in Phase 4 is where quality is gated, so implementers don't need the orchestrator's model.

- Prompt each subagent to invoke the **`do-issue`** skill for its issue number, and paste in the issue body/comments and the context-doc/ADR-filename list already gathered in Phase 1. Tell it these cover do-issue's own Phase 1 fetch, so it should skip straight to identifying the seam (reading only the specific ADRs that turn out relevant) and building its own subissue order. Tell it the brief grants commit, push, opening the PR and commenting on the issue (the Phase 1 confirm approved them), so do-issue's commit, push and PR steps run without asking again, and that the Phase 4 review replaces do-issue's own review step. do-issue otherwise handles its own worktree, adversarial hypotheses, TDD, type checks, tests, and opens a PR, so do not re-specify that here.
- Each subagent returns its branch/PR, the diff summary, and which tests it added.
- Subagents in the same wave are independent by construction (no blocked-by edge between them). If two nonetheless touch the same files, keep them serial or rely on do-issue's worktree isolation.

## Phase 4: Review each result

For every finished issue, dispatch one `reviewer` (Claude Code: the `reviewer` agent, model `opus`) with the PR diff (or the range `<main>...<branch>` to diff) and that subissue's text as the spec. The review happens at the merge gate, after the implementer's commit and PR, and the merge waits on the reviewer's final line, `VERDICT: CLEAN | PASS WITH NOTES (N) | NEEDS FIXES (N)`. Then:

- On **CLEAN** or **PASS WITH NOTES**, merge the PR (`gh pr merge --squash`), which unblocks its dependents.
- On **NEEDS FIXES**, send the findings back to the same implementer (Claude Code: `SendMessage`), or dispatch a new one with the findings where the tool cannot resume a delegate; the brief grants commit and push of the fix. Re-review once. If it still fails, stop and tell the user (see Stop conditions). Don't advance a wave on a red review, because a broken foundation breaks every issue stacked on it.

## Phase 5: Advance

Once every issue in the wave is merged, recompute unblocked issues and start the next wave (Phase 3). When the graph is drained:

- Verify the parent's acceptance criteria are met end to end; close the parent (`gh issue close <parent>`; GitHub auto-closes subissues whose PRs said `Closes #<n>`).
- Prune leftover worktrees (see [[worktrees]] for the `--force` gotchas).
- Report what merged, what's still open and why (skipped/blocked/failed review), and any subissue that needed human input.

## Stop conditions

Stop and ask the user when: the graph has a cycle; a blocker's review still returns NEEDS FIXES after the one fix attempt; a subissue needs a product decision; or two waves deadlock because every remaining issue is blocked. A stalled epic surfaced early beats a pile of half-merged branches.
