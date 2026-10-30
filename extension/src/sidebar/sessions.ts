// Sidebar Sessions view data: this folder's chats, newest first. Pure:
// the provider posts whatever this builds, and the extension resolves
// clicks back to tabs.

import { formatSessionLabel } from "../brain/brain.js";
import type { TabRecord } from "../lib/chatTabs.js";

export interface SessionRow {
  /** Tab id: live tabs focus it, the rest open it to resume. */
  uid: string;
  label: string;
  /** "2h", "3d", "just now" — "" when never used. */
  age: string;
  open: boolean;
  working: boolean;
}

/** A last-message clock as a short age; unknown clocks show nothing. */
export function formatAge(at: number | undefined, now: number): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) {
    return "";
  }
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  return `${Math.floor(days / 7)}w`;
}

function rowLabel(record: TabRecord | undefined): string {
  if (record?.labelId) {
    return formatSessionLabel(record.labelId, record.topic ?? "");
  }
  return record?.topic?.trim() ? (record.topic as string).trim() : "New chat";
}

/**
 * Open tabs and recent chats as one list, newest first. Chats never used
 * sort last. Unknown uids (live but unrecorded) show as a new chat.
 */
export function buildSessionRows(args: {
  records: Record<string, TabRecord>;
  liveUids: string[];
  clocks: Record<string, number | undefined>;
  holder: string | undefined;
  now: number;
}): SessionRow[] {
  const uids = new Set([...Object.keys(args.records), ...args.liveUids]);
  const rows: (SessionRow & { at: number })[] = [];
  for (const uid of uids) {
    const record = args.records[uid];
    const live = args.liveUids.includes(uid);
    if (!record && !live) {
      continue;
    }
    if (!live && record && !record.session && !record.labelId && !record.topic) {
      continue;
    }
    const at = args.clocks[uid];
    rows.push({
      uid,
      label: rowLabel(record),
      age: formatAge(at, args.now),
      open: live,
      working: args.holder === uid,
      at: at ?? -1,
    });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.map(({ at: _at, ...row }) => row);
}
