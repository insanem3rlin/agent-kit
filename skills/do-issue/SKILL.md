---
name: do-issue
description: Execute a GitHub issue or PRD end-to-end in the current repo — read it, parallelize subissues with subagents, generate adversarial break-hypotheses to a file, then TDD against them following the repo's testing conventions. Use when the user says "implement issue #N", "execute issue/PRD #N", "do issue #N and its subissues".
---

# Do Issue

Take a GitHub issue (often a PRD with subissues) from "open" to "implemented, tested, committed". This is the repo's standard delivery loop; do the steps unless the user narrows scope.

Setup (once, at the start): infer `<owner>/<repo>` from `git remote get-url origin`; detect the default branch (`git symbolic-ref refs/remotes/origin/HEAD --short`, referred to below as `<main>`); detect the toolchain from the repo's files (`pyproject.toml`/`uv.lock` → `uv run pytest`, `package.json` → its `scripts`, `Cargo.toml` → `cargo test`, `Makefile` targets, …). If the repo has a `CLAUDE.md`/`AGENTS.md` that pins exact commands, those win. Requires an authenticated `gh`. Run from repo root.

## Phase 0 — Always work in a new worktree

Do all the work in a fresh worktree, never on the main checkout:

```
git worktree add ../<repo>-issue-<n> -b issue-<n>
```

Run every following phase inside that worktree (`git -C <path> ...` or `cd` into it). This keeps `<main>` clean and lets the run be discarded if it goes wrong.

## Phase 1 — Read the work

```
gh issue view <n>
gh issue view <n> --comments
```
- If it's a PRD with subissues, list them (`gh issue list --search "..."` or links in the body). Build the dependency order.
- Read the repo's context docs where present (`CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, an ADR folder like `docs/adr/`) for domain language and decisions in the area you'll touch.
- Identify the seam: which module/interface owns the change? This picks where the tests go (below).

## Phase 1.5 — Grill before coding

**Only if the goal or intended behavior is unclear** after Phase 1 — the issue is ambiguous about what the user wants, or you'd be guessing at behavior only the user can settle. If the issue is clear, skip straight to Phase 2; do not manufacture questions. An open implementation detail (two defensible designs, an unpinned seam) is yours to settle: choose, proceed, and state the assumption in the final report.

Trigger examples: unspecified error/edge behavior the user must decide, a schema or API shape the issue leaves to the user, unclear scope boundary with a sibling issue, a UI decision the issue doesn't describe.

Ask the user (Claude Code: `AskUserQuestion`) — batch every open question into one round, each with a recommended default first so the user can rubber-stamp. Only push to a second round if an answer opens a genuinely new fork. For a decision that deserves real stress-testing (an architectural choice, a design you suspect is wrong), invoke the `grilling` skill instead of a single question.

Write the answers into the issue as a comment (`gh issue comment <n> --body-file ...`) so the decisions are recorded before code exists. The user's request to do the issue is the approval for commenting on that issue; a delegate comments only where its brief grants it.

## Phase 2 — Parallelize subissues

If subissues are independent, dispatch one `implementer` per subissue (Claude Code: the `implementer` agent, model `sonnet`) to implement in parallel. Keep shared-file changes serial to avoid conflicts (use worktree isolation if agents mutate the same files). Each subagent returns its diff + which tests it added.

Tell each subagent: **when the goal or intended behavior is unclear, do not guess — return the open question instead of an invented answer; for an open implementation detail, choose and list the assumption in your report.** Collect the questions, resolve them with the user as in Phase 1.5, then re-dispatch. A subagent that guessed silently at intended behavior is worse than one that stopped.

## Phase 3 — Adversarial hypotheses → file

Before/while writing code, generate "how could this code break?" hypotheses and **save them to a file** (e.g. `tests/adversarial_hypotheses.md` or `tests/<feature>_hypotheses.md`). The file is later mined (TDD targets, or filing follow-up bugs). Cover: bad input, empty/null, concurrency, encoding/apostrophes, injection, permission/scope leaks, partial failure.

## Phase 4 — TDD

Red → green → refactor against the hypotheses. If the repo documents a testing doctrine (a testing doc, ADR, or `CLAUDE.md` section), follow it; otherwise mirror how the existing tests are organized. Split tests by **seam** not feature:
- **Fast/logic tests** — call the owning module/interface directly, no UI. These own the behavior/parameter matrix.
- **End-to-end/UI journeys** — a small curated set through the real interface, asserting both surface state and persisted side effects. Write them when the issue calls for them.

**Only ever execute the fast test files that touch the changed code** — the files for the seam you edited. Never run the whole suite by default, and **never run slow end-to-end/UI suites on your own**: those run only when the user explicitly asks.

Run the project's type checker/linter (`uv run basedpyright`, `tsc --noEmit`, `cargo check`, … — whatever the toolchain detection found) and those single test files regularly during the loop (not just at the end) for tight feedback.

Respect the repo's documented conventions (import style, error handling, factory functions — see its `CLAUDE.md`/`CONTEXT.md`); no back-compat shims unless asked.

## Phase 5 — Green + finish

- Run the repo's verify command (the `## Verify` heading in its `AGENTS.md`) when it has one; otherwise the fast test files covering the changed code (see Phase 4 — no full-suite run, no journeys) and the type checker. Put the output in the report.
- Show the user what changed; once they approve, commit on the worktree branch.
- **On the user's explicit approval to push**, push the branch and open a pull request for them to review: `git push -u origin issue-<n>` then `gh pr create --base <main> --head issue-<n> --fill` (link the issue with `Closes #<n>` in the body). Leave the worktree in place until the PR is reviewed/merged.
- Before the PR is merged or handed back, unless an orchestrating skill such as `do-epic` reviews it, dispatch a `reviewer` (Claude Code: the `reviewer` agent, model `opus`) with the diff (`<main>...issue-<n>`) and the issue text, not your summary. One round: on findings, fix them once and have the fix re-reviewed once (the approvals already given for this branch cover the fix's commit and push); if that still fails, stop and tell the user.
- After the PR merges, prune the worktree (`git worktree remove`, see the `worktrees` skill for the `--force` gotchas). Close the issue with a reference to the commit (GitHub auto-closes it if the PR body says `Closes #<n>`).
- If the repo maintains user-facing guides (e.g. `USER_GUIDE.md`, localized variants), update them when behavior changed for end users.

## Phase 6 — Record deviations from the spec

If, while implementing, you made a decision that may go against what the issue asked for — a requirement you interpreted differently, one you skipped, an approach the issue didn't describe, a scope boundary you drew yourself — write your reasoning into the issue (the skill's invocation approves the comment):

```
gh issue comment <n> --body-file <file>
```

(`--body-file`, never `--body @-`.) One bullet per deviation: what the issue said, what you did instead, why. Nothing to report → skip this phase; do not invent deviations.
