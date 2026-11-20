// Which model each agent uses for each role. The tiers come from the role table in
// rules/AGENTS.md: the implementer is the standard tier and the reviewer the strong
// tier. The frontier tier is never chosen here. The Codex and Cursor values repeat
// the ones pinned in adapters/codex/agents/*.toml and adapters/cursor/agents/*.md;
// test/models.test.ts fails when they drift apart.
import type { AgentName } from "./config.ts";

export type Role = "implementer" | "reviewer";

export const MODELS: Record<AgentName, Record<Role, string>> = {
  claude: { implementer: "sonnet", reviewer: "opus" },
  codex: { implementer: "gpt-6.1-terra", reviewer: "gpt-6.1-sol" },
  cursor: { implementer: "grok-4.7-high-fast", reviewer: "claude-opus-5-5-medium" },
};

export function modelFor(agent: AgentName, role: Role): string {
  return MODELS[agent][role];
}
