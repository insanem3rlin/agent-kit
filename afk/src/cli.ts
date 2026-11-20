// Command-line entry of the AFK daemon: `init`, `--help`, and the daemon itself (src/daemon.ts).
import { createBacklogMdBacklog } from "./backlog/backlog-md.ts";
import { createGithubBacklog } from "./backlog/github.ts";
import type { Backlog } from "./backlog/types.ts";
import { loadConfig } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { loadAfkEnv, requireSecrets } from "./env.ts";
import { originOnGithub, originUrl, repoRoot } from "./git.ts";
import { githubSlug } from "./hostgit.ts";
import { initRepo } from "./init.ts";
import { createPorts } from "./sandbox.ts";

export const USAGE = `usage: agent-kit afk [options]
       agent-kit afk init

Run the AFK daemon in the current repository until Ctrl+C.

init  scaffold .afk/ (config.json and a Dockerfile) in the current repository.
`;

export async function run(argv: string[], write: (text: string) => void, cwd: string = process.cwd(), writeErr: (text: string) => void = write): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    write(USAGE);
    return 0;
  }
  if (argv[0] === "init") {
    try {
      const { dir } = initRepo(cwd);
      write(`agent-kit afk: wrote ${dir} (config.json, Dockerfile). Review config.json, then put GH_TOKEN and the agent tokens in ~/.config/agent-kit/afk.env.\n`);
      return 0;
    } catch (e) {
      write(`agent-kit afk init: ${(e as Error).message}\n`);
      return 1;
    }
  }
  try {
    return await startDaemon(cwd);
  } catch (e) {
    // Startup failures (no repository, config, afk.env or secrets): one line, exit 1.
    writeErr(`agent-kit afk: ${(e as Error).message.split("\n")[0]}\n`);
    return 1;
  }
}

async function startDaemon(cwd: string): Promise<number> {
  const root = repoRoot(cwd);
  if (!root) throw new Error(`${cwd} is not inside a git repository`);
  const config = loadConfig(root);
  const env = loadAfkEnv();
  const github = originOnGithub(root) || config.backlog === "github";
  requireSecrets(env, { agents: [config.implementer, config.reviewer], github });
  let backlog: Backlog;
  if (config.backlog === "github") {
    const slug = githubSlug(originUrl(root) ?? "");
    if (!slug) throw new Error("backlog is github, but origin is not a GitHub repository");
    backlog = createGithubBacklog({ repo: slug, label: config.label });
  } else {
    backlog = createBacklogMdBacklog({ repoDir: root, label: config.label, baseBranch: config.baseBranch });
  }
  return runDaemon({ config, env, repoDir: root, github, backlog, ports: createPorts(env) });
}
