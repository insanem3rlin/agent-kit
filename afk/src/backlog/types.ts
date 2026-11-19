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

export interface Backlog {
  /**
   * Issues that carry the AFK label, have no open blocker and no claim.
   * Fail-closed: rejects when the backlog cannot be read in full. It never
   * guesses that an issue is ready.
   */
  listReady(): Promise<BacklogIssue[]>;
  /** Swap the AFK label for `ready-for-human`, then comment. Safe to repeat. */
  markReadyForHuman(id: string, comment: string): Promise<void>;
  /** Swap the AFK label for `afk-blocked`, then comment the reason. Safe to repeat. */
  markBlocked(id: string, reason: string): Promise<void>;
  /** Comment on the issue. */
  comment(id: string, body: string): Promise<void>;
}

/** Thrown when the backlog cannot be read or written. */
export class BacklogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BacklogError";
  }
}
