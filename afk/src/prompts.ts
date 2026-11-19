// Prompt selection and rendering. A repository's `.afk/implement.md` or
// `.afk/review.md` replaces the kit's default for that phase.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "./config.ts";

export type Phase = "implement" | "review";

const DEFAULTS = new URL("../prompts/", import.meta.url);

/** The repo's override when it has one, else the kit default. `readText` returns null for a missing file. */
export function loadPrompt(phase: Phase, repoDir: string, readText: (path: string) => string | null): string {
  const override = readText(join(repoDir, CONFIG_DIR, `${phase}.md`));
  if (override !== null) return override;
  const fallback = readText(fileURLToPath(new URL(`${phase}.md`, DEFAULTS)));
  if (fallback === null) throw new Error(`the kit's default ${phase}.md prompt is missing`);
  return fallback;
}

/** Replace `{{NAME}}` in one pass, so a value that itself contains `{{...}}` is never expanded again. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) => (name in vars ? vars[name] : whole));
}
