// Pure tab bookkeeping: ids, titles, reload seeds and the per-tab message
// queue. No VS Code imports.

import { randomBytes } from "node:crypto";

/** The first chat's tab: it resumes the saved session and feeds the sidebar. */
export const MAIN_TAB_UID = "main";

/** A fresh tab id. */
export function createTabUid(): string {
  return `tab-${randomBytes(3).toString("hex")}`;
}

/** The editor tab title: the chat's topic, or the product name. */
export function tabTitle(topic: string): string {
  const clean = topic.trim();
  return clean === "" ? "Meta Betta" : clean;
}

/** What a tab needs to come back after a reload. */
export interface TabSeed {
  session?: string;
  labelId?: string;
  topic?: string;
  /** A forked tab catches up like a switched chat; a revive trusts its clock. */
  catchUp?: boolean;
}

/** The stored per-tab record: session id plus the header label. */
export interface TabRecord {
  session?: string;
  labelId?: string;
  topic?: string;
}

export interface LegacyChat {
  session?: string;
  label?: { id: string; topic: string };
}

/**
 * The seed for a revived tab: its own record, else (first tab only) the
 * pre-tabs keys. Anything else opens fresh.
 */
export function reviveSeed(
  tabUid: string,
  records: Record<string, TabRecord>,
  legacy?: LegacyChat,
): TabSeed | undefined {
  const record = records[tabUid];
  if (record && (record.session || record.labelId || record.topic)) {
    return { session: record.session, labelId: record.labelId, topic: record.topic };
  }
  if (tabUid === MAIN_TAB_UID && legacy && (legacy.session || legacy.label)) {
    return { session: legacy.session, labelId: legacy.label?.id, topic: legacy.label?.topic };
  }
  return undefined;
}

/** Clean a stored tabs record; anything else is forgotten. */
export function cleanTabRecords(value: unknown): Record<string, TabRecord> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const cleaned: Record<string, TabRecord> = {};
  for (const [uid, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const session = typeof record.session === "string" && record.session ? record.session : undefined;
    const labelId = typeof record.labelId === "string" && record.labelId ? record.labelId : undefined;
    const topic = typeof record.topic === "string" ? record.topic : undefined;
    if (session || labelId || topic) {
      cleaned[uid] = { session, labelId, topic };
    }
  }
  return cleaned;
}

/** Typed messages waiting for the lock, oldest first. */
export class MessageQueue {
  private readonly items: string[] = [];

  public constructor(private readonly limit = 5) {}

  /** Queue a message; false when the queue is full. */
  public push(text: string): boolean {
    if (this.items.length >= this.limit) {
      return false;
    }
    this.items.push(text);
    return true;
  }

  public shift(): string | undefined {
    return this.items.shift();
  }

  public get size(): number {
    return this.items.length;
  }

  public get full(): boolean {
    return this.items.length >= this.limit;
  }

  public clear(): void {
    this.items.length = 0;
  }
}
