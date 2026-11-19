# The AFK engine is TypeScript on sandcastle, outside the stdlib-only CLI

`bin/agent-kit` runs on a stock Python with the standard library only, yet the AFK daemon lives in a top-level `afk/` directory as TypeScript on `@ai-hero/sandcastle`, with its own `package.json` and lockfile. Sandcastle already provides worktrees, sandbox providers (Docker now, cloud providers for v2), agent providers for Claude Code, Codex and Cursor, re-invocation, session capture and run logs, and its maintainers keep fixing sandbox-escape and provider bugs that a home-grown loop would have to rediscover. The cost is that Node and Docker become prerequisites, but only for people who use AFK runs: `bin/agent-kit afk` launches the engine and `doctor` reports whether Node and Docker are present.

## Consequences

- Sandcastle is pinned to an exact version and bumped through Dependabot pull requests that `scripts/verify` must pass, because an unpinned upgrade would change every repository's unattended runs at once.
- The engine is tool-neutral, so it sits at the top level and not under `adapters/`.
