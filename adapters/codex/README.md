# Codex adapter

When `~/.codex` exists, `agent-kit sync`:

- writes the full text of `rules/AGENTS.md` into a marked block (`<!-- agent-kit:begin -->` ... `<!-- agent-kit:end -->`) of `~/.codex/AGENTS.md`, leaving anything outside the block alone;
- links the kit's skills into `~/.agents/skills`.

Role-to-model pinning for Codex is not implemented yet: the tiers in the rules are not mapped to Codex models.
