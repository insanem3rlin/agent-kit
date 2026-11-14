---
name: explain-issue
description: "Explain a GitHub issue in depth, covering what it actually means, why it matters, and exactly which code is involved (file:line), when the issue description alone isn't enough to understand it. Use when the user says \"explain issue #N\", \"what does issue #N mean\", \"why does #N matter\", \"walk me through issue #N\". Read-only, so it never implements or edits anything."
---

# Explain Issue

Turn a thin GitHub issue into an explanation the user can act on, delivered both as chat prose and as a standalone HTML document. This skill is **read-only on source**. Make no edits to code and create no branches, worktrees or commits. The only file you write is the explainer. If the user wants it built, that's `do-issue`.

Repo: infer `<owner>/<repo>` from `git remote get-url origin`. Requires an authenticated `gh`. Run from repo root.

## 1. Read the issue

```
gh issue view <n> --comments
```

Also pull labels and any linked/blocked-by issues mentioned in the body. If the number is missing, ask; if the user gave a title or a URL, resolve it with `gh issue list --search "..."`.

## 2. Find the code

Grep/Glob for the symbols, files, error strings, and domain terms the issue names. Trace the **real flow end to end**, from the entry point to the place the problem lives and then every caller. Read the files, don't skim. Where the issue is vague, say what you had to infer.

Consult the repo's context docs where present (`CLAUDE.md`/`AGENTS.md`/`CONTEXT.md`, an ADR folder (`docs/adr/`) when the issue touches a decided-on design, and any UI map doc for screen to file lookups).

## 3. Report

Plain prose plus code references. Cover, in this order:

1. **What the issue is asking for**, in one paragraph and in your own words. Say plainly if the issue is ambiguous or underspecified.
2. **Why it matters**, meaning the concrete consequence today: what breaks, who hits it, what it blocks. If it doesn't actually matter much, say that too.
3. **Where the code is**, meaning the involved spots as `path/file.py:123` with a short quote of the relevant lines and one line on that spot's role. Include sibling callers with the same problem; a bug report names one symptom, the code usually has more.
4. **What a fix would touch** is the shape of the change and its blast radius, not an implementation, in one paragraph.
5. **Open questions** are anything you'd need the user to decide before building.

Length follows the issue, so a one-line typo fix gets a short answer. Don't pad.

## 4. Write the HTML explainer

Write the same content to `docs/issues/<n>-explained.html` (create the folder if missing; overwrite an existing file for the same issue). Make it self-contained, with inline CSS and no external assets or CDN. Keep it plain, a readable page and not a dashboard. Include the issue number, title and link at the top, and the same five sections in the same order; code references as `<code>` with the quoted lines in a `<pre>`.

**Add a visual only where it earns its place**, which means when the thing is hard to hold in prose, such as a flow the bug travels through, an architectural decision with a before/after, a DAG or state machine, several call sites converging on one function. Prose that reads fine as prose gets no picture. One or two per document, never one per section.

Draw them as hand-written inline `<svg>`: labelled boxes, arrows, and colour to mark the broken/changed part. No JS, no diagram library. If a diagram is genuinely too complex for hand-written SVG, use the `sketchloop` skill to render it and embed the PNG as a `data:` URI so the file stays standalone.

Finish by reporting the file path, then offer `do-issue #<n>` to implement it.
