import { run } from "./cli.ts";

process.exitCode = await run(process.argv.slice(2), (text) => process.stdout.write(text), process.cwd(), (text) => process.stderr.write(text));
// Runs that outlive the shutdown wait must not keep the process alive.
setTimeout(() => process.exit(), 2000).unref();
