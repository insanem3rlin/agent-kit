// `agent-kit afk init`: scaffold `.afk/` in a repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, CONFIG_FILE, type AfkConfig } from "./config.ts";

const DOCKERFILE_TEMPLATE = new URL("../templates/Dockerfile", import.meta.url);

/** The repository's default branch from origin/HEAD, else the current branch, else "main". */
export function detectBaseBranch(repoDir: string): string {
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const origin = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
  return origin || git("symbolic-ref", "--short", "HEAD") || "main";
}

/**
 * Write `.afk/config.json` and `.afk/Dockerfile`. Never overwrites: if either
 * exists the call throws and writes nothing. No prompt overrides are written;
 * the kit's defaults apply until the user adds implement.md or review.md.
 */
export function initRepo(repoDir: string): { dir: string; config: AfkConfig } {
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
