// Sidebar Usage view data: the same numbers as /usage, shaped for the
// small panel. Pure: the provider posts whatever this builds.

import { formatSaveTime, formatUpdated } from "../brain/brain.js";
import type { UsageInfo } from "../commands/slash.js";
import { formatCost, formatTokens } from "../lib/usage.js";

export interface UsageViewData {
  today: string;
  session: string;
  allowance?: { label: string; usedPercent: number };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Today's line, the active chat's line, and the free-credits line if known. */
export function usageViewData(info: UsageInfo, now: number): UsageViewData {
  let today = `${formatTokens(info.today.totalTokens)} tokens today`;
  if (info.today.usd > 0) {
    today += ` · ${formatCost(info.today.usd)}`;
  }
  let session = "This chat: no usage yet";
  if (info.session) {
    session = `This chat: ${formatTokens(info.session.totalTokens)} total`;
    if (info.session.usd !== undefined && info.session.usd > 0) {
      session += ` · ${formatCost(info.session.usd)}`;
    }
  }
  const data: UsageViewData = { today, session };
  const slice = info.window ?? info.weekly;
  if (slice) {
    const when =
      info.window !== undefined
        ? `resets ${formatSaveTime(new Date(slice.resetsAtMs))}`
        : `resets ${formatUpdated(slice.resetsAtMs, now)}`;
    data.allowance = {
      label: `Free credits: ${clampPercent(slice.usedPercent)}% used · ${when}`,
      usedPercent: clampPercent(slice.usedPercent),
    };
  }
  return data;
}
