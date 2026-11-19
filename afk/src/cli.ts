// Command-line entry of the AFK daemon. Later issues replace the body of run().
export const USAGE = `usage: agent-kit afk [options]

Run the AFK daemon in the current repository until Ctrl+C.
`;

export function run(argv: string[], write: (text: string) => void): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    write(USAGE);
    return 0;
  }
  write("agent-kit afk: the daemon is not implemented yet\n");
  return 1;
}
