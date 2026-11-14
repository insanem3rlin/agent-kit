---
name: do-pr-comments
description: Sweep the current repo's open pull requests, implement what the user commented in reply to a review, commit onto the PR branch, and merge it. Use when the user says "do the PR comments", "implement the PR feedback", "go through the open PRs", "fix and merge the PRs".
---

# Do PR Comments

This skill automates the following loop. An agent opens a PR, a review is posted as a PR comment, the user replies with a comment saying how they want it fixed, and this skill implements that reply, commits on the PR branch, and merges to the default branch.

Setup happens once, at the start. Infer `<owner>/<repo>` from `git remote get-url origin`; detect the default branch (`git symbolic-ref refs/remotes/origin/HEAD --short`, referred to below as `<main>`); detect the toolchain from the repo's files (`pyproject.toml`/`uv.lock`, `package.json` scripts, `Cargo.toml`, `Makefile`, …), and a `CLAUDE.md`/`AGENTS.md` that pins exact commands wins. Requires an authenticated `gh`. Run from repo root.

## Phase 1: Inventory

```
gh pr list --state open --json number,title,headRefName,isDraft
```

Skip drafts unless the user names one. Without arguments do **all** open PRs; with `#N` do only that one.

For each PR, fetch comments and the last commit date:

```
gh pr view <n> --json number,title,url,headRefName,body,comments,commits,files
gh api repos/<owner>/<repo>/pulls/<n>/comments   # inline review-thread comments
```

**Unaddressed means created after the last commit's `committedDate`.** With no such comments there is nothing to do, so skip the PR (the last run already committed a response to everything older).

## Phase 2: Separate directive from context

Agents often commit and comment as the repo owner, so every comment may share one author. **Do not filter by author.** Filter by shape and recency:

- The **directive** is the newest human-written comment(s) after the last commit. It is short, imperative, and often quotes or replies to the review ("do the first two, skip the timeout one", "fix it like X instead"). This is what you implement.
- The **context** is a long structured review report (headings, `file:line` findings, "Reviewed `<main>...HEAD`", verdict tables). Read it to understand what the directive refers to, but **never implement a review's findings that the directive didn't ask for**.

If the only comment after the last commit is a review with no user reply, the user hasn't decided yet, so **skip the PR and report it as "awaiting your instruction"**. Do not act on the review alone.

If the directive is ambiguous (which of several findings, or "fix it properly" with no target), ask the user (Claude Code: `AskUserQuestion`) in one batched round for **all** PRs, recommended default first, rather than guessing. Do this before spawning subagents; subagents never ask the user.

## Phase 3: One subagent per PR

Phases 4 to 7 run in one `implementer` subagent per PR (Claude Code: the `implementer` agent, model `sonnet`), all spawned in **one message** so they run concurrently. Do not do the work inline; the main agent only inventories, triages, and reports.

Each subagent's prompt carries everything it needs (it cannot see this conversation):

- PR number, title, `headRefName`, url
- the directive text, verbatim
- the relevant excerpt of the review it replies to (context only)
- the phases below, verbatim
- the grant, which says the brief grants commit, push and the PR reply on this PR's branch (merging stays with the main agent)

With one PR to do, it is still one subagent with the same flow.

## Phase 4: Work on the PR branch (subagent)

Never work on the main checkout's `<main>`. Check for an existing worktree on that branch first:

```
git worktree list
```

- If the branch is already checked out in a worktree, work there (`git -C <wt> ...`).
- Otherwise create one with `git worktree add ../<repo>-pr-<n> <headRefName>` (fetch first with `git fetch origin <headRefName>`).

Make sure the branch is current with `git -C <wt> pull --ff-only`.

Each PR gets its **own** worktree, so concurrent subagents never share a checkout.

## Phase 5: Implement (subagent)

Implement exactly what the directive asks and nothing else, which rules out scope creep and drive-by "while I'm here" fixes. The repo's documented conventions apply (import style, error handling, factories, see its `CLAUDE.md`/`CONTEXT.md`/testing docs where present); no back-compat shims.

If the directive requires a behavior change with a test seam, add/adjust the focused test for that seam; for a bug fix, write the test that fails because of the bug first.

## Phase 6: Verify (subagent)

Run the repo's verify command (the `## Verify` heading in its `AGENTS.md`) when it has one; otherwise the project's type check plus the test files covering the changed code, e.g.:

```
uv run basedpyright && uv run pytest <files>     # or the toolchain's equivalent
```

Run only the test files touching the changed seam. **Never** run the whole suite by default, and **never** run slow end-to-end/UI journeys. Those run only when the user explicitly asks.

On red tests or type errors, fix them or stop and report. Do not merge on unverified work.

## Phase 7: Commit, push, reply (subagent)

The user's request to do the PR comments is the approval for this commit, push and reply, and for the merge in Phase 8.

```
git -C <wt> commit -am "<what the comment asked for> (PR #<n>)"
git -C <wt> push
gh pr comment <n> --body-file <file>
```

Use `--body-file`, never `--body @-` (it stores the literal `@-`). The reply is short, with one bullet per instruction stating what you changed, plus the verification output (type check + which test files, pass counts). Say plainly if something in the directive was **not** done and why.

The subagent **stops here** and does not merge. Its final text is the return value, made up of the PR number, worktree path, what it did per instruction, verification output, `MERGEABLE` or `BLOCKED: <reason>`.

## Phase 8: Merge (main agent, serial)

Merges run in the main agent, **one PR at a time**, since concurrent merges to `<main>` race and produce avoidable conflicts. Match the repo's merge style (check a few recently merged PRs; if unclear, ask once):

```
gh pr merge <n> --merge --delete-branch      # or --squash, per repo style
```

Merge only when **all** of these hold:
- the subagent returned `MERGEABLE`,
- every point in the directive is implemented or explicitly declined in the reply,
- the type check is clean and the relevant test files pass,
- the PR has no merge conflict with `<main>`,
- a `reviewer` (Claude Code: the `reviewer` agent, model `opus`), given the new commit's diff and the directive as the spec, ends with `VERDICT: CLEAN` or `PASS WITH NOTES`. This review is the merge gate, run after the commit on the PR's own branch.

On a conflict (or a merge that fails because an earlier PR in the sweep landed first), send the findings or the conflict back to the same implementer (Claude Code: `SendMessage`; a new `implementer` with the context where the tool cannot resume one) to merge `<main>` into its branch, resolve, re-run the tests, and push, since it still has the worktree and the context. Then retry the merge.

On `NEEDS FIXES`, the implementer gets the findings for one more attempt, the reviewer re-reviews once, and if that still fails the main agent takes the work over or leaves the PR open and tells the user which.

Otherwise leave the PR open and say why in the report.

After each merge, prune that PR's worktree:

```
git worktree remove <wt>          # --force if the .venv symlink or long paths block it
git worktree prune
```

If the PR body says `Closes #<n>`, GitHub closes the issue itself; otherwise close it with a link to the merge commit.

## Phase 9: Report

Give one table for the sweep: PR, what the directive asked, what you did, verification result, merged / left open + reason. Include nothing else. The subagents' reports are not shown to the user, so relay what matters.
