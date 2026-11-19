import { spawn } from "node:child_process";
import { AGENTS, BacklogError } from "./types.ts";
import type { Agent, Backlog, BacklogIssue } from "./types.ts";

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

export const defaultGh: Gh = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`gh ${args.slice(0, 2).join(" ")} exited ${code}: ${err.trim()}`)),
    );
    child.stdin.end(input ?? "");
  });

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

type AgentChoice = { ok: true; agent?: Agent } | { ok: false };

function chooseAgent(labels: string[], prefix: string): AgentChoice {
  const overrides = labels.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
  if (overrides.length === 0) return { ok: true };
  const agent = AGENTS.find((a) => a === overrides[0]);
  if (overrides.length > 1 || agent === undefined) return { ok: false };
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

  return {
    async listReady() {
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
      for (const i of issues) {
        const id = String(i.number);
        if (claimed.has(id) || isBlocked(i)) continue;
        const choice = chooseAgent(i.labels.map((l) => l.name), `${label}:`);
        if (!choice.ok) continue;
        ready.push({ id, title: i.title, body: i.body ?? "", url: i.url, ...(choice.agent && { agent: choice.agent }) });
      }
      return ready;
    },
    markReadyForHuman: (id, comment) => swap(id, READY_FOR_HUMAN, comment),
    markBlocked: (id, reason) => swap(id, AFK_BLOCKED, reason),
    async comment(id, body) {
      await run(["issue", "comment", requireIssueNumber(id), "--repo", repo, "--body-file", "-"], body);
    },
  };
}
