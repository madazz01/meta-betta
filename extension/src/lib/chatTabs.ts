// Pure tab bookkeeping: ids, titles, reload seeds and the per-tab message
// queue. No VS Code imports.

import { randomBytes } from "node:crypto";
import type { TranscriptEntry } from "./session.js";

/** The first chat's tab: it resumes the saved session. */
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
  /** A forked tab replays the source chat's transcript at fork time. */
  transcript?: TranscriptEntry[];
}

/** The stored per-tab record: session id plus the header label. */
export interface TabRecord {
  session?: string;
  labelId?: string;
  topic?: string;
}

/** Pre-tabs storage keys, now the first tab's keys. */
export const SESSION_STORE_KEY = "metaBetta.sessionId";
export const TRANSCRIPT_STORE_KEY = "metaBetta.transcript";

/**
 * Per-tab storage key. The first tab keeps the pre-tabs key (no migration);
 * other tabs suffix their own.
 */
export function tabStorageKey(base: string, uid: string): string {
  return uid === MAIN_TAB_UID ? base : `${base}.${uid}`;
}

/**
 * Keys a failed session resume forgets: the dead id only. The stored
 * transcript and clock survive as the fallback — never start fresh while
 * old data exists.
 */
export function clearedKeysOnFailedResume(uid: string): string[] {
  return uid === MAIN_TAB_UID ? [SESSION_STORE_KEY] : [];
}

/**
 * Only the first tab adopts the pre-tabs label, and only when it has no
 * seed of its own. A fresh tab always starts blank with its own label.
 */
export function adoptsStoredLabel(uid: string, seed?: TabSeed): boolean {
  return uid === MAIN_TAB_UID && !seed?.labelId;
}

/** A forked tab's topic: the source topic, marked. Blank stays blank. */
export function forkTopic(topic: string): string {
  const clean = topic.trim();
  return clean === "" ? "" : `${clean} (fork)`;
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

/** An open or recent chat that a message might refer to. */
export interface PeekCandidate {
  uid: string;
  /** Short session id ("58f2"). */
  id: string;
  /** Full header label ("Session 58f2 · todo"). */
  label: string;
  topic: string;
}

/**
 * The chat a message asks to peek at, if any: an explicit session label or
 * topic first, else "the other tab/chat" (exactly one other), else
 * "earlier/yesterday's chat" (the first chat). Never the sender itself,
 * never a guess between several.
 */
export function findPeekTarget(
  text: string,
  selfUid: string,
  chats: PeekCandidate[],
): PeekCandidate | undefined {
  const lower = text.toLowerCase();
  const others = chats.filter((chat) => chat.uid !== selfUid);
  const explicit = others.find(
    (chat) =>
      (chat.topic.length >= 3 && lower.includes(chat.topic.toLowerCase())) ||
      (chat.id !== "" && new RegExp(`\\b${chat.id.toLowerCase()}\\b`).test(lower)),
  );
  if (explicit) {
    return explicit;
  }
  if (/\bother\s+(tab|chat)\b/.test(lower) && others.length === 1) {
    return others[0];
  }
  if (/\b(earlier|yesterday'?s?)\s+chat\b/.test(lower)) {
    return others.find((chat) => chat.uid === MAIN_TAB_UID);
  }
  return undefined;
}

const PEEK_LINE_LIMIT = 400;
const PEEK_BLOCK_LIMIT = 4000;

/**
 * The peek background: the other chat's last entries as You/Muse lines,
 * newest kept when over budget.
 */
export function formatPeekBackground(label: string, entries: TranscriptEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.role !== "user" && entry.role !== "assistant") {
      continue;
    }
    const text = entry.text.replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }
    lines.push(`${entry.role === "user" ? "You" : "Muse"}: ${text.slice(0, PEEK_LINE_LIMIT)}`);
  }
  while (lines.join("\n").length > PEEK_BLOCK_LIMIT && lines.length > 1) {
    lines.shift();
  }
  return (
    `[Also relevant: the last messages of '${label}'. Use them only as background for this turn.]\n` +
    lines.join("\n")
  );
}

/**
 * Output-channel lines for queue state changes only: a message starts
 * waiting, leaves for the host, or is dropped. Retries stay silent.
 */
export function queueQueuedNote(uid: string, waiting: number, holder: string | undefined): string {
  return holder === undefined
    ? `queue: ${uid} queued (${waiting} waiting)`
    : `queue: ${uid} queued (${waiting} waiting, held by ${holder})`;
}

export function queueSentNote(uid: string): string {
  return `queue: ${uid} sent`;
}

export function queueDroppedNote(uid: string, waiting: number, why: string): string {
  return `queue: ${uid} dropped ${waiting} waiting (${why})`;
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
