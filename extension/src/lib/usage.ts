// Usage numbers: formatting plus the per-day totals behind /usage and the
// status bar. No VS Code imports.

/** One session's running totals (cumulative tokenUsage, cost when priced). */
export interface SessionUsageTotals {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  usd?: number;
  partial?: boolean;
}

/** "999", "12.4k", "1.5M". */
export function formatTokens(count: number): string {
  if (count < 1000) {
    return String(Math.max(0, Math.floor(count)));
  }
  if (count < 1_000_000) {
    return `${trimOne(count / 1000)}k`;
  }
  return `${trimOne(count / 1_000_000)}M`;
}

function trimOne(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded);
}

/** "~$0.03". Always an estimate: the server says so. */
export function formatCost(usd: number): string {
  return `~$${usd.toFixed(2)}`;
}

/** "☕ Muse · 15.5k tokens · ~$0.03", quieter when there's less to say. */
export function formatStatusBar(usage: SessionUsageTotals | undefined): string {
  if (!usage) {
    return "☕ Muse";
  }
  const tokens = `☕ Muse · ${formatTokens(usage.totalTokens)} tokens`;
  return usage.usd === undefined ? tokens : `${tokens} · ${formatCost(usage.usd)}`;
}

/** Each session's latest totals for one day (globalState, "today" card). */
export interface DayUsage {
  date: string;
  sessions: Record<string, SessionUsageTotals>;
}

/** Record a session's latest totals; a new day starts over. */
export function recordDayUsage(
  prev: DayUsage | undefined,
  today: string,
  sessionId: string,
  totals: SessionUsageTotals,
): DayUsage {
  const sessions = prev && prev.date === today ? { ...prev.sessions } : {};
  sessions[sessionId] = totals;
  return { date: today, sessions };
}

/** Today's summed tokens and cost across sessions. */
export function sumDayUsage(day: DayUsage | undefined): { totalTokens: number; usd: number } {
  let totalTokens = 0;
  let usd = 0;
  for (const totals of Object.values(day?.sessions ?? {})) {
    totalTokens += totals.totalTokens;
    usd += totals.usd ?? 0;
  }
  return { totalTokens, usd: Math.round(usd * 1000) / 1000 };
}

/** Validate stored day usage; junk becomes undefined, bad rows are dropped. */
export function cleanDayUsage(value: unknown): DayUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const day = value as { date?: unknown; sessions?: unknown };
  if (typeof day.date !== "string" || typeof day.sessions !== "object" || day.sessions === null) {
    return undefined;
  }
  const sessions: Record<string, SessionUsageTotals> = {};
  for (const [id, entry] of Object.entries(day.sessions as Record<string, unknown>)) {
    const totals = entry as {
      promptTokens?: unknown;
      outputTokens?: unknown;
      totalTokens?: unknown;
      usd?: unknown;
      partial?: unknown;
    };
    if (
      typeof totals?.promptTokens !== "number" ||
      typeof totals.outputTokens !== "number" ||
      typeof totals.totalTokens !== "number"
    ) {
      continue;
    }
    sessions[id] = {
      promptTokens: totals.promptTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      ...(typeof totals.usd === "number" && Number.isFinite(totals.usd)
        ? { usd: totals.usd, partial: totals.partial === true }
        : {}),
    };
  }
  return { date: day.date, sessions };
}

/** Local "YYYY-MM-DD" day key. */
export function todayKey(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
