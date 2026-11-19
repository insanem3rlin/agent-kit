// The per-machine AFK secrets, `~/.config/agent-kit/afk.env` (or $AGENT_KIT_CONFIG/afk.env).
//
// A missing file is an error, not an empty environment: a run without tokens
// can only fail later and less clearly inside a sandbox.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentName } from "./config.ts";

export type AfkEnv = Record<string, string>;

/** For each agent, the variables of which at least one must be set. */
export const AGENT_TOKEN_VARS: Record<AgentName, readonly string[]> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
};

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

export function afkEnvPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = env.AGENT_KIT_CONFIG || join(home, ".config", "agent-kit");
  return join(dir, "afk.env");
}

/** Parse dotenv text: `KEY=VALUE`, `export KEY=VALUE`, `#` comment lines, matching quotes stripped. */
export function parseEnv(source: string): AfkEnv {
  const out: AfkEnv = {};
  source.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(trimmed);
    if (!m) throw new EnvError(`afk.env line ${i + 1}: expected KEY=VALUE`);
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  });
  return out;
}

export function loadAfkEnv(path: string = afkEnvPath()): AfkEnv {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new EnvError(
      `${path} not found; create it with GH_TOKEN and a token for each agent in use (AFK_NOTIFY_URL is optional)`,
    );
  }
  return parseEnv(source);
}

/** Fail unless GH_TOKEN and a token for every listed agent are set and non-empty. */
export function requireSecrets(env: AfkEnv, agents: readonly AgentName[]): void {
  if (!env.GH_TOKEN) throw new EnvError("GH_TOKEN is missing or empty in afk.env");
  for (const agent of new Set(agents)) {
    const names = AGENT_TOKEN_VARS[agent];
    if (!names.some((n) => env[n])) {
      throw new EnvError(`${names.join(" or ")} is missing or empty in afk.env (needed for agent ${agent})`);
    }
  }
}
