// Command-line entry of the AFK daemon. Later issues replace the body of run().
import { initRepo } from "./init.ts";

export const USAGE = `usage: agent-kit afk [options]
       agent-kit afk init

Run the AFK daemon in the current repository until Ctrl+C.

init  scaffold .afk/ (config.json and a Dockerfile) in the current repository.
`;

export function run(argv: string[], write: (text: string) => void, cwd: string = process.cwd()): number {
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
  write("agent-kit afk: the daemon is not implemented yet\n");
  return 1;
}
