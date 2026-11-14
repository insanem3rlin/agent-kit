# Gemini CLI adapter

When `~/.gemini` exists, `agent-kit sync`:

- writes the full text of `rules/AGENTS.md` into a marked block of `~/.gemini/GEMINI.md`, leaving anything outside the block alone;
- links the kit's skills into `~/.agents/skills`, which Gemini CLI reads as an alias of `~/.gemini/skills`;
- links the role agents in `agents/` into `~/.gemini/agents`, each pinned to a model of its tier: `researcher` on `gemini-3.5-flash-lite`, `implementer` on `gemini-3.5-flash`, `reviewer` on `gemini-3.1-pro-preview`;
- adds the context7 reminder to `~/.gemini/settings.json` as an `AfterTool` hook on `write_file` and `replace`, where no hook already runs that script.

The agent files repeat the instructions of `adapters/claude-code/agents/`; a test fails when the two drift apart. They leave `tools` unset, so each agent has the session's tools and the read-only roles are read-only by instruction.
