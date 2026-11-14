# Cursor adapter

When `~/.cursor` exists, `agent-kit sync`:

- links the kit's skills into `~/.agents/skills`;
- links the role agents in `agents/` into `~/.cursor/agents`. Cursor also reads `~/.claude/agents`, but those name Claude Code model aliases, and a `~/.cursor/agents` file of the same name wins. The agents use `model: inherit` until the tier models are pinned to IDs from `agent models`; `researcher` is `readonly`.

Cursor has no user rules file on disk. User Rules live in Customize > Rules, so paste `rules/AGENTS.md` there once; project `AGENTS.md` files are read as they are.

Cursor runs the hooks in `~/.claude/settings.json` (Settings > Agents > Third-Party Imports, on by default), so the context7 reminder reaches Cursor through the Claude Code adapter and the kit writes no `~/.cursor/hooks.json`. Cursor reads only the agents in `~/.cursor/agents` in the desktop app, not in the `agent` CLI.
