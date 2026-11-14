# agent-kit: contributor rules

This repository is public. It ships rules, skills, roles and hooks to other machines, so every file here is read by agents elsewhere.

- `rules/AGENTS.md` is the generic rules file that gets linked into each tool. It has a hard cap of 100 lines: to add a rule, remove or move another. Procedures belong in a skill, checkable rules in a hook or a test.
- The core (`rules/`, `skills/`, `hooks/`) is tool-neutral. Anything specific to one tool lives under `adapters/<tool>/`.
- Nothing private enters a tracked file: no person or company names, hostnames, home-directory paths, project names or secrets. Machine-local state lives in `~/.config/agent-kit/`.
- Skills fetched from other authors are listed in `sources.json` and pulled onto each machine at sync time. Their content is never copied into this repository.
- `bin/agent-kit` runs on a stock `python3` (3.9+) with the standard library only.

## Verify

```
scripts/verify
```
