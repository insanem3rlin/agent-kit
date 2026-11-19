// `agent-kit afk init`: scaffold `.afk/` in a repository.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, CONFIG_FILE, type AfkConfig } from "./config.ts";
import { detectBaseBranch, repoRoot } from "./git.ts";

const DOCKERFILE_TEMPLATE = new URL("../templates/Dockerfile", import.meta.url);

/**
 * Write `.afk/config.json` and `.afk/Dockerfile` at the root of the git work tree
 * containing `startDir`; outside a work tree it throws. Never overwrites: if either
 * exists the call throws and writes nothing. No prompt overrides are written;
 * the kit's defaults apply until the user adds implement.md or review.md.
 */
export function initRepo(startDir: string): { dir: string; config: AfkConfig } {
  const repoDir = repoRoot(startDir);
  if (repoDir === null) throw new Error(`${startDir} is not inside a git work tree; run it in the repository`);
  const dir = join(repoDir, CONFIG_DIR);
  for (const name of [CONFIG_FILE, "Dockerfile"]) {
    if (existsSync(join(dir, name))) throw new Error(`${join(dir, name)} already exists; leaving it untouched`);
  }
  const config: AfkConfig = {
    backlog: "github",
    label: "afk",
    baseBranch: detectBaseBranch(repoDir),
    implementer: "claude",
    reviewer: "claude",
    concurrency: 1,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n");
  writeFileSync(join(dir, "Dockerfile"), readFileSync(DOCKERFILE_TEMPLATE, "utf8"));
  return { dir, config };
}
