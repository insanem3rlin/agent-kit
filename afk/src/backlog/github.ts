import { spawn } from "node:child_process";
import { AGENTS, BacklogError } from "./types.ts";
import type { Agent, Backlog, BacklogIssue, RejectedIssue, SwapContext } from "./types.ts";

/** Runs `gh` with the arguments and optional stdin; resolves with stdout, rejects on any failure. */
export type Gh = (args: string[], input?: string) => Promise<string>;

export interface GithubBacklogOptions {
  /** `owner/name` of the repository whose issues are the backlog. */
  repo: string;
  /** The AFK label, `afk` by default in the config. */
  label: string;
  gh?: Gh;
}

export const READY_FOR_HUMAN = "ready-for-human";
export const AFK_BLOCKED = "afk-blocked";
const LIST_LIMIT = 1000;

export function spawnGh(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    let writeError: Error | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // gh may exit before reading its input; the failed write must not become an uncaught error.
    child.stdin.on("error", (e) => (writeError = e));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && writeError === undefined) return resolve(out);
      const why = code === 0 ? `could not write its input: ${writeError?.message}` : `exited ${code}: ${err.trim()}`;
      reject(new Error(`gh ${args.slice(0, 2).join(" ")} ${why}`));
    });
    child.stdin.end(input ?? "");
  });
}

export const defaultGh: Gh = (args, input) => spawnGh("gh", args, input);

interface RawIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: { name: string }[];
  blockedBy: { totalCount: number; nodes: { state?: string }[] };
}

function parseIssues(text: string): RawIssue[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("expected a JSON array");
  for (const i of data) {
    const ok =
      i !== null && typeof i === "object" &&
      Number.isInteger(i.number) && typeof i.title === "string" && typeof i.url === "string" &&
      Array.isArray(i.labels) && i.labels.every((l: { name?: unknown }) => typeof l?.name === "string") &&
      Array.isArray(i.blockedBy?.nodes) && Number.isInteger(i.blockedBy?.totalCount);
    if (!ok) throw new Error("issue has an unexpected shape");
  }
  return data as RawIssue[];
}

// An issue is blocked unless every blocker is known to be closed, and unless
// gh returned all of them. Anything unreadable counts as open.
function isBlocked(i: RawIssue): boolean {
  const { nodes, totalCount } = i.blockedBy;
  return totalCount > nodes.length || nodes.some((n) => n?.state !== "CLOSED");
}

export type AgentChoice = { ok: true; agent?: Agent } | { ok: false; reason: string };

export function chooseAgent(labels: string[], prefix: string): AgentChoice {
  const overrides = labels.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
  if (overrides.length === 0) return { ok: true };
  const agent = AGENTS.find((a) => a === overrides[0]);
  if (overrides.length > 1) {
    return { ok: false, reason: `conflicting agent labels: ${overrides.map((o) => prefix + o).join(", ")}; keep one` };
  }
  if (agent === undefined) {
    return { ok: false, reason: `unknown agent label ${prefix}${overrides[0]}; use one of ${AGENTS.map((a) => prefix + a).join(", ")}` };
  }
  return { ok: true, agent };
}

function requireIssueNumber(id: string): string {
  if (!/^[1-9][0-9]*$/.test(id)) throw new BacklogError(`not an issue number: ${JSON.stringify(id)}`);
  return id;
}

export function createGithubBacklog(options: GithubBacklogOptions): Backlog {
  const { repo, label } = options;
  const gh = options.gh ?? defaultGh;

  async function run(args: string[], input?: string): Promise<string> {
    try {
      return await gh(args, input);
    } catch (cause) {
      throw new BacklogError(`GitHub backlog is not readable or writable: ${String(cause)}`, { cause });
    }
  }

  async function claimedIds(): Promise<Set<string>> {
    const out = await run(["api", `repos/${repo}/git/matching-refs/heads/afk/`, "--paginate", "--jq", ".[].ref"]);
    const ids = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      const m = /^refs\/heads\/afk\/(.+)$/.exec(line.trim());
      if (m) ids.add(m[1]);
    }
    return ids;
  }

  async function ensureLabel(name: string): Promise<void> {
    try {
      await gh(["label", "create", name, "--repo", repo]);
    } catch (cause) {
      if (/already exists/i.test(String(cause))) return;
      throw new BacklogError(`cannot create label ${name}: ${String(cause)}`, { cause });
    }
  }

  async function swap(id: string, to: string, comment: string): Promise<void> {
    const n = requireIssueNumber(id);
    await ensureLabel(to);
    await run(["issue", "edit", n, "--repo", repo, "--add-label", to, "--remove-label", label]);
    await run(["issue", "comment", n, "--repo", repo, "--body-file", "-"], comment);
  }

  async function scan(): Promise<{ ready: BacklogIssue[]; rejected: RejectedIssue[] }> {
    const out = await run([
      "issue", "list", "--repo", repo, "--label", label, "--state", "open",
      "--limit", String(LIST_LIMIT), "--json", "number,title,body,url,labels,blockedBy",
    ]);
    let issues: RawIssue[];
    try {
      issues = parseIssues(out);
    } catch (cause) {
      throw new BacklogError(`unreadable gh output: ${String(cause)}`, { cause });
    }
    if (issues.length >= LIST_LIMIT) throw new BacklogError("backlog listing hit its limit; refusing to guess");
    const claimed = await claimedIds();
    const ready: BacklogIssue[] = [];
    const rejected: RejectedIssue[] = [];
    for (const i of issues) {
      const id = String(i.number);
      if (claimed.has(id) || isBlocked(i)) continue;
      const choice = chooseAgent(i.labels.map((l) => l.name), `${label}:`);
      if (!choice.ok) {
        rejected.push({ id, reason: choice.reason });
        continue;
      }
      ready.push({ id, title: i.title, body: i.body ?? "", url: i.url, ...(choice.agent && { agent: choice.agent }) });
    }
    return { ready, rejected };
  }

  return {
    async listReady() {
      return (await scan()).ready;
    },
    async listRejected() {
      return (await scan()).rejected;
    },
    markReadyForHuman: (id, comment, _ctx) => swap(id, READY_FOR_HUMAN, comment),
    markBlocked: (id, reason, _ctx) => swap(id, AFK_BLOCKED, reason),
    async comment(id, body) {
      await run(["issue", "comment", requireIssueNumber(id), "--repo", repo, "--body-file", "-"], body);
    },
  };
}
