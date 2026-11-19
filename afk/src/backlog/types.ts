// The backlog contract. The GitHub backlog (#5) and the Backlog.md backlog (#6)
// both implement it, so the AFK run (#7) and the daemon loop (#8) do not care
// which one a repository uses.

export const AGENTS = ["claude", "codex", "cursor"] as const;
export type Agent = (typeof AGENTS)[number];

/** One unit of work. `id` is what the claim branch `afk/<id>` is named after. */
export interface BacklogIssue {
  id: string;
  title: string;
  body: string;
  url: string;
  /** Implementer chosen by an `<label>:<agent>` label; undefined means the configured default. */
  agent?: Agent;
}

/** An issue that carries the AFK label but cannot run as labelled, with the reason to show a human. */
export interface RejectedIssue {
  id: string;
  reason: string;
}

/**
 * Where the caller is working. The GitHub backlog ignores it. The Backlog.md
 * backlog commits its label swap and comments on the run's branch
 * `afk/<id>` inside `workdir` and never pushes; the run pushes.
 */
export interface SwapContext {
  workdir?: string;
}

export interface Backlog {
  /**
   * Issues that carry the AFK label, have no open blocker, no claim and a
   * valid agent override. Fail-closed: rejects when the backlog cannot be read
   * in full. It never guesses that an issue is ready, and has no side effects.
   */
  listReady(): Promise<BacklogIssue[]>;
  /**
   * Issues that would be ready but for an invalid or conflicting agent
   * override. They are kept out of listReady, and nothing is changed here: the
   * daemon (#8) calls markBlocked(id, reason) on each so a human sees why.
   */
  listRejected(): Promise<RejectedIssue[]>;
  /**
   * Swap the AFK label for `ready-for-human`, then comment. The label swap is
   * idempotent; the comment is posted again on every call.
   */
  markReadyForHuman(id: string, comment: string, ctx?: SwapContext): Promise<void>;
  /**
   * Swap the AFK label for `afk-blocked`, then comment the reason. The label
   * swap is idempotent; the comment is posted again on every call.
   */
  markBlocked(id: string, reason: string, ctx?: SwapContext): Promise<void>;
  /**
   * Comment on the issue. The GitHub backlog ignores `ctx`. The Backlog.md
   * backlog appends the comment to the task file and commits it in
   * `ctx.workdir`, and rejects without one, because it never writes to the
   * base branch.
   */
  comment(id: string, body: string, ctx?: SwapContext): Promise<void>;
}

/** Thrown when the backlog cannot be read or written. */
export class BacklogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BacklogError";
  }
}
