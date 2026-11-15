# Codex adapter

When `~/.codex` exists, `agent-kit sync`:

- writes the full text of `rules/AGENTS.md` into a marked block (`<!-- agent-kit:begin -->` ... `<!-- agent-kit:end -->`) of `~/.codex/AGENTS.md`, leaving anything outside the block alone;
- links the kit's skills into `~/.agents/skills`;
- links the role agents in `agents/` into `~/.codex/agents`, each pinned to a model of its tier: `researcher` on `gpt-6-luna`, `implementer` on `gpt-6.1-terra`, `reviewer` on `gpt-6.1-sol`;
- adds the context7 reminder to `~/.codex/hooks.json` as a `PostToolUse` hook on `apply_patch`, where no hook already runs that script.

The agent files repeat the instructions of `adapters/claude-code/agents/`; a test fails when the two drift apart. Codex lets an agent file pick its model but not narrow its sandbox, so the read-only roles are read-only by instruction.

Codex runs a new or changed hook only after the user trusts it with `/hooks`, so the reminder stays inactive until then.
