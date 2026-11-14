# agent-kit

One set of working rules, skills and roles for coding agents, installed once per machine and used by every agent tool on it: Claude Code, Hermes, Codex, Gemini CLI, Cursor.

## What you get

- **Rules.** [`rules/AGENTS.md`](rules/AGENTS.md): under 100 lines on verification, tests, scope, asking, approval, delegation, review and where knowledge is kept. It is loaded into every session of every tool.
- **Roles with fixed model tiers.** A `researcher` on the cheap tier, an `implementer` on the standard tier, a `reviewer` on the strong tier. In Claude Code these are subagents pinned to `haiku`, `sonnet` and `opus`, in Codex agents pinned to `gpt-6-luna`, `gpt-6.1-terra` and `gpt-6.1-sol`, in Gemini CLI to `gemini-3.5-flash-lite`, `gemini-3.5-flash` and `gemini-3.1-pro-preview`, so the model follows from the role and a delegate never inherits the session's model.
- **Skills.** The kit's own skills in [`skills/`](skills), plus skills by other authors listed in [`sources.json`](sources.json), which are fetched from their own repositories on each sync and never copied here.
- **Hooks.** Checks that back the rules. The Claude Code, Codex and Gemini CLI adapters wire them, and Cursor runs the Claude Code ones.

## Install

```sh
git clone https://github.com/insanem3rlin/agent-kit.git ~/.agent-kit
~/.agent-kit/install.sh
```

`install.sh` covers macOS and Linux. On Windows, run it natively from PowerShell (not WSL), with Developer Mode on for symbolic links:

```powershell
git clone https://github.com/insanem3rlin/agent-kit.git ~\.agent-kit
powershell -ExecutionPolicy Bypass -File ~\.agent-kit\install.ps1
```

There `bin\agent-kit.ps1` stands in for `bin/agent-kit` (it finds a real Python 3.10+), and the hourly timer is the scheduled task `agent-kit-sync`.

To have an agent do it (Claude Code, Codex, Gemini CLI, Cursor or Hermes), tell it: "Install https://github.com/insanem3rlin/agent-kit by following its INSTALL.md." The file [`INSTALL.md`](INSTALL.md) is written for that agent. After the install it also audits the rules and skills already on the machine and in your repositories, removes what the kit now duplicates, and reports conflicts and leaked secrets.

The installer links the kit into each tool it finds and adds an hourly timer that pulls the repository, refreshes the external skills and re-links. It never overwrites: something already present under a name the kit wants is reported as a conflict and left alone. `install.sh --adopt` moves such entries to a backup directory and links the kit's version.

```sh
~/.agent-kit/bin/agent-kit doctor      # what is installed, linked, stale or conflicting
~/.agent-kit/bin/agent-kit sync        # what the timer runs
~/.agent-kit/bin/agent-kit uninstall   # removes exactly what the kit added
```

## What it changes on a machine

| Tool | Found by | Rules | Skills | Other |
|---|---|---|---|---|
| Claude Code | `~/.claude` | an import line in a marked block of `~/.claude/CLAUDE.md` | links in `~/.claude/skills` | the three agents in `~/.claude/agents`; hook, statusline and subagent-model fallback merged into `settings.json` where those keys are unset |
| Hermes | `~/.hermes` | the rules text in a marked block of `~/.hermes/SOUL.md` | links in `~/.hermes/skills` | |
| Codex | `~/.codex` | the rules text in a marked block of `~/.codex/AGENTS.md` | links in `~/.agents/skills` | the three agents in `~/.codex/agents`; the docs-lookup hook in `~/.codex/hooks.json`, active once trusted with `/hooks` |
| Gemini CLI | `~/.gemini` | the rules text in a marked block of `~/.gemini/GEMINI.md` | links in `~/.agents/skills` | the three agents in `~/.gemini/agents`; the docs-lookup hook merged into `~/.gemini/settings.json` |
| Cursor | `~/.cursor` | none on disk: paste `rules/AGENTS.md` into Customize > Rules once | links in `~/.agents/skills` | the three agents in `~/.cursor/agents`, which override the Claude Code ones Cursor also reads |

Permission modes, secrets and the session model are never touched. Machine-local state is in `~/.config/agent-kit/`.

## In a repository

The kit lives on the machine, so a repository needs only its own short `AGENTS.md`. The rules expect one thing from it, a verify command:

````markdown
## Verify

```
npm run lint && npm run typecheck && npm test -- --changed
```
````

Agents run it after each change and show its output before reporting work as done. Keep it fast; it is not the full suite.

## Design

- **Short rules, mechanical checks.** A rule that a script can check becomes a hook or part of the verify command. Prose is what is left.
- **A neutral core with thin adapters.** `rules/`, `skills/` and `hooks/` assume no tool. Everything specific to one tool is under `adapters/<tool>/`.
- **Shared and machine-local are kept apart.** The repository holds what is the same everywhere. Secrets, permission modes and paths stay on the machine.
- **Knowledge belongs to the project.** Agents write what they learn into the project's files, where every agent and person can read it, and keep no private memory of project facts.

## Contributing

See [`AGENTS.md`](AGENTS.md). `scripts/verify` runs the leak check and the tests.

## Licence

MIT
