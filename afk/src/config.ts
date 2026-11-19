// The per-repository AFK configuration, `.afk/config.json`.
//
// Validation is strict on purpose: every field is required and unknown keys are
// rejected. A silent default for baseBranch or the agents would point unattended
// runs at the wrong branch or the wrong agent, and a typo'd key would otherwise
// be ignored without a trace. Errors name the field and the problem.
//
// Fields added from now on must be optional, with a default applied here, so
// that a config written before the field existed keeps loading. The six
// fields below stay required.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS } from "./backlog/types.ts";

export const BACKLOG_KINDS = ["github", "backlog-md"] as const;
export { AGENTS };

export type BacklogKind = (typeof BACKLOG_KINDS)[number];
export type AgentName = (typeof AGENTS)[number];

export interface AfkConfig {
  backlog: BacklogKind;
  label: string;
  baseBranch: string;
  implementer: AgentName;
  reviewer: AgentName;
  concurrency: number;
}

export const CONFIG_DIR = ".afk";
export const CONFIG_FILE = "config.json";

export class ConfigError extends Error {
  field: string;
  constructor(field: string, problem: string) {
    super(`${field}: ${problem}`);
    this.name = "ConfigError";
    this.field = field;
  }
}

function oneOf<T extends string>(raw: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const value = raw[field];
  if (!allowed.includes(value as T)) {
    throw new ConfigError(field, `must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
  }
  return value as T;
}

function text(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(field, `must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

export function parseConfig(raw: unknown): AfkConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("config", "must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const known = ["backlog", "label", "baseBranch", "implementer", "reviewer", "concurrency"];
  for (const key of known) {
    if (!(key in obj)) throw new ConfigError(key, "required, but missing");
  }
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) throw new ConfigError(key, "unknown field");
  }
  const concurrency = obj.concurrency;
  if (typeof concurrency !== "number" || !Number.isInteger(concurrency)) {
    throw new ConfigError("concurrency", `must be an integer (got ${JSON.stringify(concurrency)})`);
  }
  if (concurrency < 1) {
    throw new ConfigError("concurrency", `must be at least 1 (got ${concurrency})`);
  }
  return {
    backlog: oneOf(obj, "backlog", BACKLOG_KINDS),
    label: text(obj, "label"),
    baseBranch: text(obj, "baseBranch"),
    implementer: oneOf(obj, "implementer", AGENTS),
    reviewer: oneOf(obj, "reviewer", AGENTS),
    concurrency,
  };
}

/** Load and validate `<repoDir>/.afk/config.json`. */
export function loadConfig(repoDir: string): AfkConfig {
  const path = join(repoDir, CONFIG_DIR, CONFIG_FILE);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError("config", `${path} not found; run \`agent-kit afk init\` in the repository`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new ConfigError("config", `${path} is not valid JSON`);
  }
  return parseConfig(raw);
}
