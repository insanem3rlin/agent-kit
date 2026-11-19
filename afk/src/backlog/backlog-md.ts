// The Backlog.md backlog: the same contract as the GitHub backlog (types.ts),
// kept in task files committed in the repository. See docs/adr/0003.
//
// Who does what. This module reads, edits and commits; it never pushes.
//   - Reading (listReady, listRejected): fetches the base branch from the
//     remote into the private ref `refs/afk/base` and reads the task files from
//     that ref, never from the checkout, so a checkout on an AFK branch or with
//     local edits cannot change the answer. Claims come from
//     `git ls-remote --heads <remote> refs/heads/afk/*`. The fetch and the
//     ls-remote never prompt and time out (remoteGitOptions in ../git.ts).
//     Tasks come from tasks/, completed/ and archive/tasks/; only tasks/ can
//     run, but every folder counts for dependencies and duplicate ids. Done is
//     the last entry of `statuses` in config.yml (default "Done"), and ids
//     compare case-insensitively without zero-padding.
//   - Writing (markReadyForHuman, markBlocked, comment): edits the task file in
//     `ctx.workdir`, which must be the run's checkout on branch `afk/<id>`, and
//     makes one `git commit` there. Without a workdir, or on any other branch,
//     they reject, so nothing is ever committed to the base branch.
//   - The run (#7) pushes `afk/<id>`. Pushing the branch is also the claim. For
//     a blocked run the pushed branch holds only the swap commit, so the task is
//     not retried until a human deletes the branch.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { remoteGitOptions } from "../git.ts";
import { AFK_BLOCKED, READY_FOR_HUMAN, chooseAgent } from "./github.ts";
import { BacklogError } from "./types.ts";
import type { Backlog, BacklogIssue, RejectedIssue, SwapContext } from "./types.ts";

/** Runs `git` with the arguments; resolves with stdout, rejects on any failure. */
export type Git = (args: string[], options?: { cwd?: string; remote?: boolean }) => Promise<string>;

export interface BacklogMdBacklogOptions {
  /** A checkout of the repository; used for `fetch` and `ls-remote`, never read for task files. */
  repoDir: string;
  /** The AFK label, `afk` by default in the config. */
  label: string;
  /** Git remote that holds the base branch and the claim branches. Default `origin`. */
  remote?: string;
  /** Base branch the task files are read from. Default `main`. */
  baseBranch?: string;
  /** Backlog.md's directory inside the repository. Default `backlog`. */
  backlogDir?: string;
  git?: Git;
  /** Clock for comment headings. */
  now?: () => Date;
}

const BASE_REF = "refs/afk/base";
const COMMENTS_HEADING = "## AFK comments";

export const defaultGit: Git = (args, options) =>
  new Promise((resolve, reject) => {
    // Commands that talk to the remote never prompt and time out (see remoteGitOptions).
    const network = options?.remote && options.cwd !== undefined ? remoteGitOptions(options.cwd) : {};
    const child = spawn("git", args, { cwd: options?.cwd, ...network, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    // A timed-out git is killed, but on Windows its helpers (git-remote-https)
    // keep the pipes open, so "close" may never come. Settle on the kill itself.
    child.on("exit", (_code, signal) => {
      if (!signal) return;
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`git ${args.slice(0, 2).join(" ")} was killed (${signal}): ${err.trim()}`));
    });
    child.on("close", (code) => {
      if (code === 0) return resolve(out);
      reject(new Error(`git ${args.slice(0, 2).join(" ")} exited ${code}: ${err.trim()}`));
    });
  });

// ---------------------------------------------------------------------------
// Task files. Backlog.md writes YAML frontmatter; only the fields below are
// read, in the forms Backlog.md and the yaml library emit (block or flow lists,
// plain, single- or double-quoted scalars). Anything else throws, which makes
// the whole listing fail closed.

export interface Task {
  id: string;
  title: string;
  status: string;
  labels: string[];
  dependencies: string[];
  body: string;
}

interface Field {
  /** Index of the key line within the frontmatter lines, and the end of its block (exclusive). */
  start: number;
  end: number;
  rest: string;
  items: string[];
}

interface Parsed {
  eol: string;
  /** Lines before the frontmatter's opening `---` (a BOM only) are dropped; fm excludes both delimiters. */
  fm: string[];
  after: string[];
  fields: Map<string, Field>;
  task: Task;
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) throw new Error(`unterminated string ${s}`);
    return s.slice(1, -1).replace(/\\(.)/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) throw new Error(`unterminated string ${s}`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s.replace(/\s+#.*$/, "");
}

function splitFlow(inner: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') cur += inner[++i] ?? "";
      else if (c === quote) {
        if (quote === "'" && inner[i + 1] === "'") cur += inner[++i];
        else quote = undefined;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ",") {
      items.push(cur);
      cur = "";
    } else if ("[]{}".includes(c)) {
      throw new Error("nested flow collections are not supported");
    } else cur += c;
  }
  if (quote) throw new Error("unterminated string in a list");
  if (cur.trim() !== "" || items.length > 0) items.push(cur);
  return items.map((i) => {
    if (i.trim() === "") throw new Error("empty list item");
    return unquote(i);
  });
}

function parseFile(text: string): Parsed {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") throw new Error("no frontmatter");
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (close < 0) throw new Error("frontmatter is not closed");
  const fm = lines.slice(1, close);
  const after = lines.slice(close + 1);

  const fields = readFields(fm);
  return finish(eol, fm, after, fields);
}

function readFields(fm: string[]): Map<string, Field> {
  const fields = new Map<string, Field>();
  let current: Field | undefined;
  fm.forEach((line, i) => {
    const key = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (key) {
      if (fields.has(key[1])) throw new Error(`duplicate field ${key[1]}`);
      current = { start: i, end: i + 1, rest: (key[2] ?? "").trim(), items: [] };
      fields.set(key[1], current);
      return;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      if (current) current.end = i + 1;
      return;
    }
    const item = /^\s*-(?:\s+(.*))?$/.exec(line);
    if (current && item && current.rest === "") {
      current.items.push(unquote(item[1] ?? ""));
      current.end = i + 1;
      return;
    }
    if (current && /^\s/.test(line)) {
      // A continuation of a scalar (folded or literal). Fine for fields we ignore.
      current.end = i + 1;
      current.rest = current.rest + "\u0000";
      return;
    }
    throw new Error(`cannot read frontmatter line ${JSON.stringify(line)}`);
  });
  return fields;
}

function listField(fields: Map<string, Field>, name: string): string[] | undefined {
  const f = fields.get(name);
  if (!f) return undefined;
  if (f.rest === "") return f.items;
  if (f.items.length > 0 || f.rest.includes("\u0000")) throw new Error(`field ${name} is not a plain list`);
  if (f.rest.startsWith("[") && f.rest.endsWith("]")) return splitFlow(f.rest.slice(1, -1));
  throw new Error(`field ${name} is not a list`);
}

function finish(eol: string, fm: string[], after: string[], fields: Map<string, Field>): Parsed {
  const scalar = (name: string, required: boolean): string => {
    const f = fields.get(name);
    if (!f) {
      if (required) throw new Error(`missing field ${name}`);
      return "";
    }
    if (f.items.length > 0 || f.rest === "") {
      if (required) throw new Error(`field ${name} has no plain value`);
      return "";
    }
    if (f.rest.includes("\u0000")) {
      if (required) throw new Error(`field ${name} spans several lines`);
      return unquote(f.rest.replace(/\u0000/g, "").trim());
    }
    return unquote(f.rest);
  };
  const list = (name: string): string[] => listField(fields, name) ?? [];

  const id = scalar("id", true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`unusable task id ${JSON.stringify(id)}`);
  let title = "";
  try {
    title = scalar("title", false);
  } catch {
    title = "";
  }
  const task: Task = {
    id,
    title,
    status: scalar("status", false),
    labels: list("labels"),
    dependencies: list("dependencies"),
    body: after.join(eol).replace(/^\s*\n/, ""),
  };
  return { eol, fm, after, fields, task };
}

export function parseTask(text: string): Task {
  return parseFile(text).task;
}

/** The statuses of backlog/config.yml; the last one is the final ("Done") status. */
export function parseStatuses(text: string): string[] | undefined {
  return listField(readFields(text.replace(/^\uFEFF/, "").split(/\r?\n/)), "statuses");
}

/** Ids compare case-insensitively and without zero-padding: BACK-001.02 is BACK-1.2. */
export function normalizeId(id: string): string {
  return id.trim().toLowerCase().replace(/\b0+(?=\d)/g, "");
}

function formatItem(s: string): string {
  const plain = /^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/.test(s) && !/^[0-9.]+$/.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s) && !s.endsWith(":");
  return plain ? s : `'${s.replace(/'/g, "''")}'`;
}

/** Rewrites the labels field of a task file as a block list, leaving every other byte alone. */
export function setLabels(text: string, labels: string[]): string {
  const p = parseFile(text);
  const block = labels.length === 0 ? ["labels: []"] : ["labels:", ...labels.map((l) => `  - ${formatItem(l)}`)];
  const f = p.fields.get("labels");
  const fm = [...p.fm];
  if (f) fm.splice(f.start, f.end - f.start, ...block);
  else fm.push(...block);
  const bom = text.startsWith("﻿") ? "﻿" : "";
  return bom + ["---", ...fm, "---", ...p.after].join(p.eol);
}

function appendComment(text: string, body: string, when: Date): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = text.endsWith("\n") ? text : text + eol;
  if (!out.split(/\r?\n/).some((l) => l.trimEnd() === COMMENTS_HEADING)) out += eol + COMMENTS_HEADING + eol;
  const note = body.replace(/\r?\n/g, eol).replace(/\s+$/, "");
  return out + eol + `### ${when.toISOString()}` + eol + eol + note + eol;
}

// ---------------------------------------------------------------------------

function requireTaskId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new BacklogError(`not a task id: ${JSON.stringify(id)}`);
  return id;
}

export function createBacklogMdBacklog(options: BacklogMdBacklogOptions): Backlog {
  const { repoDir, label } = options;
  const remote = options.remote ?? "origin";
  const baseBranch = options.baseBranch ?? "main";
  const dir = options.backlogDir ?? "backlog";
  const git = options.git ?? defaultGit;
  const now = options.now ?? (() => new Date());
  if (isAbsolute(dir) || dir.split(/[\\/]/).includes("..") || dir === "") {
    throw new BacklogError(`backlogDir must be a relative path inside the repository: ${JSON.stringify(dir)}`);
  }

  async function run(args: string[], cwd: string, remoteCall = false): Promise<string> {
    try {
      return await git(args, remoteCall ? { cwd, remote: true } : { cwd });
    } catch (cause) {
      throw new BacklogError(`Backlog.md backlog is not readable or writable: ${String(cause)}`, { cause });
    }
  }

  async function claimedIds(): Promise<Set<string>> {
    const out = await run(["ls-remote", "--heads", remote, "refs/heads/afk/*"], repoDir, true);
    const ids = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      const m = /^[0-9a-f]+\s+refs\/heads\/afk\/(.+)$/.exec(line.trim());
      if (m) ids.add(normalizeId(m[1]));
    }
    return ids;
  }

  /**
   * The final status from the base ref's Backlog.md config, or "Done" without one.
   * Backlog.md reads a root `backlog.config.yml` first and `<dir>/config.yml` otherwise.
   */
  async function finalStatus(): Promise<string> {
    const candidates = ["backlog.config.yml", `${dir}/config.yml`];
    const names = (await run(["ls-tree", "-z", "--name-only", BASE_REF, "--", ...candidates], repoDir)).split("\0");
    const file = candidates.find((c) => names.includes(c));
    if (!file) return "done";
    let statuses: string[] | undefined;
    try {
      statuses = parseStatuses(await run(["show", `${BASE_REF}:${file}`], repoDir));
    } catch (cause) {
      throw new BacklogError(`unreadable ${file}: ${String(cause)}`, { cause });
    }
    if (statuses === undefined) return "done";
    const last = statuses[statuses.length - 1]?.trim();
    if (!last) throw new BacklogError(`${file} has an empty statuses list`);
    return last.toLowerCase();
  }

  async function readTasks(): Promise<{ path: string; task: Task; live: boolean }[]> {
    const listing = await run(
      ["ls-tree", "-r", "-z", "--name-only", BASE_REF, "--", `${dir}/tasks`, `${dir}/completed`, `${dir}/archive/tasks`],
      repoDir,
    );
    const paths = listing.split("\0").filter((p) => p.endsWith(".md"));
    paths.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const tasks: { path: string; task: Task; live: boolean }[] = [];
    const seen = new Map<string, string>();
    for (const path of paths) {
      const text = await run(["show", `${BASE_REF}:${path}`], repoDir);
      let task: Task;
      try {
        task = parseFile(text).task;
      } catch (cause) {
        throw new BacklogError(`unreadable task file ${path}: ${String(cause)}`, { cause });
      }
      const key = normalizeId(task.id);
      const first = seen.get(key);
      if (first !== undefined) throw new BacklogError(`duplicate task id ${task.id} in ${first} and ${path}`);
      seen.set(key, path);
      // Only tasks under tasks/ can run; completed/ (legacy) and archive/tasks are archived.
      tasks.push({ path, task, live: path.startsWith(`${dir}/tasks/`) });
    }
    return tasks;
  }

  async function scan(): Promise<{ ready: BacklogIssue[]; rejected: RejectedIssue[] }> {
    await run(["fetch", "--quiet", remote, `+refs/heads/${baseBranch}:${BASE_REF}`], repoDir, true);
    const final = await finalStatus();
    const isDone = (t: Task) => t.status.trim().toLowerCase() === final;
    const tasks = await readTasks();
    const claimed = await claimedIds();
    const byId = new Map(tasks.map((t) => [normalizeId(t.task.id), t.task]));
    const ready: BacklogIssue[] = [];
    const rejected: RejectedIssue[] = [];
    for (const { path, task, live } of tasks) {
      if (!live || !task.labels.includes(label) || isDone(task)) continue;
      if (claimed.has(normalizeId(task.id))) continue;
      // An unknown dependency counts as open.
      if (task.dependencies.some((d) => { const dep = byId.get(normalizeId(d)); return dep === undefined || !isDone(dep); })) continue;
      const choice = chooseAgent(task.labels, `${label}:`);
      if (!choice.ok) {
        rejected.push({ id: task.id, reason: choice.reason });
        continue;
      }
      ready.push({ id: task.id, title: task.title, body: task.body, url: path, ...(choice.agent && { agent: choice.agent }) });
    }
    return { ready, rejected };
  }

  /** Edits the task file in the run's checkout and commits it; the one write path. */
  async function edit(id: string, ctx: SwapContext | undefined, message: string, change: (text: string, task: Task) => string): Promise<void> {
    requireTaskId(id);
    const workdir = ctx?.workdir;
    if (workdir === undefined || workdir === "") {
      throw new BacklogError("the Backlog.md backlog writes to the run's checkout; pass ctx.workdir (a checkout on afk/<id>)");
    }
    const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"], workdir)).trim();
    if (branch.toLowerCase() !== `afk/${id}`.toLowerCase()) {
      throw new BacklogError(`refusing to commit on ${JSON.stringify(branch)}; the checkout must be on afk/${id}`);
    }
    const tasksDir = join(workdir, dir, "tasks");
    const prefix = `${id.toLowerCase()} - `;
    let names: string[];
    try {
      names = readdirSync(tasksDir).filter((n) => n.toLowerCase().startsWith(prefix) && n.endsWith(".md"));
    } catch (cause) {
      throw new BacklogError(`cannot read ${tasksDir}: ${String(cause)}`, { cause });
    }
    if (names.length !== 1) throw new BacklogError(`expected one task file for ${id} in ${tasksDir}, found ${names.length}`);
    const file = join(tasksDir, names[0]);
    const text = readFileSync(file, "utf8");
    let updated: string;
    try {
      const task = parseFile(text).task;
      if (task.id.toLowerCase() !== id.toLowerCase()) throw new Error(`file declares id ${task.id}`);
      updated = change(text, task);
    } catch (cause) {
      throw new BacklogError(`cannot update ${names[0]}: ${String(cause)}`, { cause });
    }
    writeFileSync(file, updated);
    const rel = `${dir}/tasks/${names[0]}`;
    await run(["add", "--", rel], workdir);
    await run(["commit", "--quiet", "-m", message, "--", rel], workdir);
  }

  const swap = (to: string, id: string, note: string, ctx: SwapContext | undefined) =>
    edit(id, ctx, `afk: ${id} ${label} -> ${to}`, (text, task) => {
      const labels = task.labels.filter((l) => l !== label);
      if (!labels.includes(to)) labels.push(to);
      return appendComment(setLabels(text, labels), note, now());
    });

  return {
    listReady: async () => (await scan()).ready,
    listRejected: async () => (await scan()).rejected,
    markReadyForHuman: (id, comment, ctx) => swap(READY_FOR_HUMAN, id, comment, ctx),
    markBlocked: (id, reason, ctx) => swap(AFK_BLOCKED, id, reason, ctx),
    comment: (id, body, ctx) => edit(id, ctx, `afk: comment on ${id}`, (text) => appendComment(text, body, now())),
  };
}
