# Hermes adapter

Hermes loads `SOUL.md` on every session and reads `AGENTS.md` files verbatim, without following `@` imports. That is why `agent-kit sync` copies the full text of `rules/AGENTS.md` into a marked block (`<!-- agent-kit:begin -->` ... `<!-- agent-kit:end -->`) of `~/.hermes/SOUL.md`. Text outside the block is never touched, and the block is rewritten only when the rules change. If `SOUL.md` is a symlink, the write goes to its target.

Skills are linked into `~/.hermes/skills`, one symlink per skill.

## Model tiers

The rules name three tiers. In Hermes they map to the models configured in `config.yaml`:

| Tier | Hermes model |
|---|---|
| cheap | the cheapest configured model |
| standard | the default model |
| strong | the strongest configured model |

The kit does not edit `config.yaml`.
