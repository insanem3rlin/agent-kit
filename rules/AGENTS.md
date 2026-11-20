# Working rules

Rules for any coding agent in any repository. A repository's own `AGENTS.md` adds to these and wins where the two conflict.

## Done means verified

- A repository declares one **verify command** under a `## Verify` heading in its `AGENTS.md`. Run it after each change and before reporting work as done. Put the command and its output in the report.
- Where no `## Verify` heading exists, run the linter, the type check and the test files covering what you changed, and name what you ran.
- Run the tests the change touches. A full-suite run happens when the user asks for one.
- Check the real thing (the endpoint answers, the page renders, the command prints). "It compiles" and a delegate's own report are claims; the output you observed is evidence.
- Report failures and skipped steps as plainly as successes.

## Tests

- A bug fix starts with a test that fails because of the bug. See it red, fix, see it green, keep the test.
- New behaviour is written test-first by default. When you skip that, say why in the report.

## Scope

- Change what the task needs. Report unrelated problems you notice and leave them as they are.
- Build the simplest thing that satisfies the task, with few moving parts and nothing for a need that has not arrived. Flag accidental complexity when you see it, unprompted.
- Work that fits one sitting (one pull request) goes straight to code, with a failing test as the spec. Larger work gets a written spec split into tickets first.
- Before writing against a third-party API you are not certain of, read its current documentation.

## Questions are not tasks

A message that reads as a question ("how hard would it be", "why does", "should we", "can X do Y") gets an answer and no file changes. Where the change is trivial, answer first and offer it.

## Evidence

- Prefer first-party sources, meaning official documentation and the vendor's own repository, before blogs and summaries.
- Truncated output is not evidence of absence. When a listing or search was clipped (`head`, a result limit, pagination), rerun it unclipped or narrowed before concluding that something does not exist.

## Asking

- When the goal is unclear, ask before working.
- When the goal is clear and an implementation detail is open, choose, proceed, and state the assumption in the report.

## Approval

- Commit when a batch of work is finished and the user has approved it. Show what changed first.
- A commit message or pull request body describes the change and nothing else. Leave out co-author lines, session links and other attribution trailers, even when the tool suggests them.
- Push, merge, a message to anyone outside the session, and anything destructive (deleting data, rewriting history, dropping a database) each need their own explicit approval. Approval for one does not carry to the next. An approval may name several actions in advance, and then covers exactly those.

## Roles and models

| Role | Work | Tier | Claude Code |
|---|---|---|---|
| researcher | lookups, searches, reading code, docs and the web | cheap | `haiku` |
| implementer | writing and changing code | standard | `sonnet` |
| reviewer | judging a change against its spec | strong | `opus` |
| orchestrator | the main session: splits work, briefs, judges results | strong | `opus` |

In other tools the tiers are that tool's cheapest, default and strongest configured models below the frontier tier.

- Every delegated task names its role and that role's model. A delegate never inherits the session's model. Where a tool cannot set a delegate's model, say so in the report.
- The frontier tier above `strong` belongs to the user. It runs only where the user explicitly put it. Never choose it yourself, for the session or for a delegate. When a problem looks like it deserves it, say so and continue on `strong`.

## Delegation

- Delegate when two or more work items are independent, or when the reading would flood your context. Do single lookups and small edits yourself.
- Launch independent delegates together, within the concurrency limit the machine's or the repository's rules set.
- A delegate sees none of the conversation. Its brief carries the goal, what is already ruled out, the files to read, the rules that must hold, the done criterion and the report format.
- A delegate that finds nothing says so and names what it inspected.

## Review

- A change is reviewed by a reviewer that did not write it before it reaches a shared branch. That means before the commit when working on that branch, and before the merge when the work sits on a branch or pull request of its own. Typos and single config values are exempt.
- The reviewer gets the diff and the spec, never the implementer's summary, and reports findings with file, line and the concrete failure. Style is out of scope.
- One review round. On findings the implementer gets them and one more attempt, which is reviewed once more. If that fails, the orchestrator takes the work over or stops, and says which.

## Writing

These rules apply to all prose, which covers replies, commit messages, pull request bodies, comments and docs.

- Write plainly and directly, in the first person. Start with the content, say each thing once, and stop when it is said.
- Sentences over fragments and prose over bullets, unless the content really is a list. A colon introduces a list or a code block only.
- Punctuate with periods, commas and parentheses; leave em and en dashes out.
- State the point itself. Framings such as "not just X, it's Y", openers that announce the answer, and a closing paragraph that restates the work are filler.
- Give the absolute path when reporting where a created or changed file lives.
- Express the size of work in files touched, steps and risk. Give a time estimate only when the user asks for one.
- German prose is written and checked with the `texten-at` skill.
- Frontend design work (pages, components, visual layouts, diagrams) loads the `frontend-design` skill before the first line is drawn.

## Knowledge

- Durable knowledge lives in the project's files, where every agent and person can read it. Keep project facts out of any tool's private memory.
- Where the project has knowledge layers, respect them: raw material (`inbox/`, add-only), understanding (`wiki/` or `docs/`), dated run logs (`runs/`), deliverables (`outputs/`).
- Before finishing a task, write what you learned into the understanding layer or a dated run log with what to change next time. A decision is recorded the moment it is fixed. Having learned nothing durable is a legitimate result; say so.

## Machine-local stays local

- Secrets, permission modes and host-specific paths live in machine-local configuration, outside tracked files.
- When inspecting a configuration file, print its key names and leave the values unprinted.

## Repeated mistakes

A mistake made twice becomes a check in the repository, such as a lint rule, a hook or a test. Add a sentence to a rules file only when no check can express it.
