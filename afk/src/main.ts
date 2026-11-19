import { run } from "./cli.ts";

process.exitCode = run(process.argv.slice(2), (text) => process.stdout.write(text));
