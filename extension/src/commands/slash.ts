// Slash commands: /usage, /resume, /model … A static registry (the / menu
// and /help list every entry, so nothing stays hidden) plus a pure parser.
// Each entry's run() drives the panel through SlashContext, a narrow seam
// tests fake to check the words and wiring without a live Muse.

import { formatSaveTime, formatUpdated } from "../brain/brain.js";
import { shortReason } from "../lib/startup.js";
import { formatCost, formatTokens, type SessionUsageTotals } from "../lib/usage.js";

export interface ParsedSlash {
  name: string;
  args: string;
}

/**
 * "/usage" → command, "/model x" → command + args. A bare "/" asks for help.
 * The name is letters only, so paths like "/tmp/foo" stay ordinary chat.
 */
export function parseSlashCommand(text: string): ParsedSlash | undefined {
  if (!text.startsWith("/")) {
    return undefined;
  }
  const rest = text.slice(1).trim();
  if (rest === "") {
    return { name: "help", args: "" };
  }
  const space = rest.search(/\s/);
  const word = (space === -1 ? rest : rest.slice(0, space)).toLowerCase().replace(/[.!?,;:]+$/, "");
  if (!/^[a-z]+$/.test(word)) {
    return undefined;
  }
  return { name: word, args: space === -1 ? "" : rest.slice(space).trim() };
}

export interface CardButtonSpec {
  id: string;
  label: string;
}

export interface CardInputSpec {
  id: string;
  placeholder: string;
  buttonLabel: string;
}

/** One compact result card. Buttons and the input come back via handlers. */
export interface CardSpec {
  title: string;
  body: string;
  buttons?: CardButtonSpec[];
  input?: CardInputSpec;
}

export interface CardHandlers {
  onButton?: (buttonId: string) => void | Promise<void>;
  onInput?: (text: string) => void | Promise<void>;
}

export interface ResumeSession {
  id: string;
  name: string;
  /** RFC3339 last activity; "" when unknown. */
  updatedAt: string;
  turnCount: number;
}

export interface ModelRow {
  modelId: string;
  label: string;
  active: boolean;
}

export interface TaskRow {
  taskId: string;
  label: string;
  detail: string;
}

export interface SkillRow {
  selector: string;
  name: string;
  description: string;
}

export interface PluginRow {
  id: string;
  version: string;
  enabled: boolean;
}

/** One account allowance slice (weekly or current window), when reported. */
export interface AllowanceSlice {
  usedPercent: number;
  resetsAtMs: number;
}

export interface UsageInfo {
  session?: SessionUsageTotals;
  today: { totalTokens: number; usd: number };
  weekly?: AllowanceSlice;
  window?: AllowanceSlice;
}

export interface GoalInfo {
  objective: string;
  percentComplete: number;
  status: string;
  currentWork?: string;
  nextWork?: string;
}

export type EffortLevel = "quick" | "normal" | "deep";

export const EFFORT_LEVELS: EffortLevel[] = ["quick", "normal", "deep"];
export const EFFORT_LABELS: Record<EffortLevel, string> = { quick: "Quick", normal: "Normal", deep: "Deep" };

/** Everything a slash command can do: cards, notices, chats, Muse calls. */
export interface SlashContext {
  showCard(card: CardSpec, handlers?: CardHandlers): string;
  updateCard(id: string, card: CardSpec): void;
  closeCard(id: string): void;
  notice(kind: "info" | "error", text: string): void;
  newChat(): Promise<void>;
  saveMyDay(): Promise<void>;
  stop(): void;
  clearView(): void;
  focusBrain(): Promise<void>;
  /** Save the chat to a file; undefined when the user cancels. */
  exportHistory(): Promise<string | undefined>;
  listSessions(): Promise<ResumeSession[]>;
  switchToSession(id: string): Promise<void>;
  readUsage(): Promise<UsageInfo>;
  listModels(): Promise<ModelRow[]>;
  setModel(modelId: string): Promise<void>;
  compact(): Promise<"compacted" | "noop">;
  recap(): Promise<{ text: string; title?: string }>;
  goal(op: "set" | "edit" | "pause" | "resume" | "clear", text?: string): Promise<void>;
  currentGoal(): GoalInfo | null;
  sideAsk(question: string, onProgress?: (line: string) => void): Promise<string>;
  /** Fork from here and switch to the new chat. */
  fork(): Promise<void>;
  listTasks(): Promise<TaskRow[]>;
  stopTask(taskId: string): Promise<void>;
  stopAllTasks(): Promise<void>;
  listSkills(): Promise<SkillRow[]>;
  setSkill(selector: string, on: boolean): Promise<void>;
  listPlugins(): Promise<PluginRow[]>;
  /** Install from "store:name" or a folder path; resolves to one plain line. */
  installPlugin(spec: string): Promise<string>;
  setEffort(level: EffortLevel): Promise<void>;
  currentEffort(): EffortLevel;
}

export interface SlashCommandDef {
  name: string;
  description: string;
  run(ctx: SlashContext, args: string): void | Promise<void>;
}

/** Friendly words for a failed Muse call; version gaps say so plainly. */
export function commandErrorText(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === -32601
  ) {
    return "Not available in this version of Muse Code yet";
  }
  return shortReason(error);
}

export function unknownCommandText(name: string): string {
  return `I don't know /${name}, type /help`;
}

/** Validate a stored goal; anything but a well-formed one clears the pin. */
export function cleanGoalInfo(value: unknown): GoalInfo | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object") {
    return null;
  }
  const goal = value as {
    objective?: unknown;
    percentComplete?: unknown;
    status?: unknown;
    currentWork?: unknown;
    nextWork?: unknown;
  };
  if (
    typeof goal.objective !== "string" ||
    goal.objective === "" ||
    typeof goal.percentComplete !== "number" ||
    !Number.isFinite(goal.percentComplete) ||
    typeof goal.status !== "string"
  ) {
    return null;
  }
  return {
    objective: goal.objective,
    percentComplete: goal.percentComplete,
    status: goal.status,
    ...(typeof goal.currentWork === "string" ? { currentWork: goal.currentWork } : {}),
    ...(typeof goal.nextWork === "string" ? { nextWork: goal.nextWork } : {}),
  };
}

/** Validate a stored effort level; junk falls back to normal. */
export function cleanEffortLevel(value: unknown): EffortLevel {
  return value === "quick" || value === "normal" || value === "deep" ? value : "normal";
}

export type PluginSpec =
  | { kind: "marketplace"; marketplace: string; name: string }
  | { kind: "path"; path: string };

/** "store:name" → marketplace arm, anything path-shaped → folder arm. */
export function parsePluginSpec(spec: string): PluginSpec | undefined {
  const clean = spec.trim();
  if (clean === "") {
    return undefined;
  }
  if (/^([A-Za-z]:[\\/]|\\\\|[\\/]|\.|~|file:)/.test(clean)) {
    return { kind: "path", path: clean };
  }
  const colon = clean.indexOf(":");
  if (colon > 0) {
    const marketplace = clean.slice(0, colon).trim();
    const name = clean.slice(colon + 1).trim();
    return marketplace !== "" && name !== "" ? { kind: "marketplace", marketplace, name } : undefined;
  }
  return undefined;
}

const CONTRIBUTOR_WARNING =
  "Runs on your free credits, and Meta may use what you type to improve their models. Don't paste anything private.";
const USAGE_DASHBOARD = "https://dev.meta.ai/platform";

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: "help",
    description: "Show this list",
    run(ctx) {
      ctx.showCard({
        title: "Shortcuts",
        body: SLASH_COMMANDS.map((def) => `- **/${def.name}** — ${def.description}`).join("\n"),
      });
    },
  },
  {
    name: "new",
    description: "Start a fresh chat",
    run(ctx) {
      return ctx.newChat();
    },
  },
  {
    name: "resume",
    description: "Switch to an earlier chat",
    run(ctx) {
      return resumeRun(ctx);
    },
  },
  {
    name: "save",
    description: "Save my day into the brain",
    run(ctx) {
      return ctx.saveMyDay();
    },
  },
  {
    name: "usage",
    description: "Tokens, cost and limits",
    run(ctx) {
      return usageRun(ctx);
    },
  },
  {
    name: "model",
    description: "Show or switch the model",
    run(ctx, args) {
      return modelRun(ctx, args);
    },
  },
  {
    name: "compact",
    description: "Tidy up a long chat",
    run(ctx) {
      return compactRun(ctx);
    },
  },
  {
    name: "recap",
    description: "Summarise where we're up to",
    run(ctx) {
      return recapRun(ctx);
    },
  },
  {
    name: "goal",
    description: "Pin a goal for this chat",
    run(ctx, args) {
      return goalRun(ctx, args);
    },
  },
  {
    name: "side",
    description: "Ask a quick side question",
    run(ctx, args) {
      return sideRun(ctx, args);
    },
  },
  {
    name: "fork",
    description: "Try another way from here",
    run(ctx) {
      return forkRun(ctx);
    },
  },
  {
    name: "tasks",
    description: "See what's running, stop any",
    run(ctx) {
      return tasksRun(ctx);
    },
  },
  {
    name: "skills",
    description: "Browse skills, turn on or off",
    run(ctx) {
      return skillsRun(ctx);
    },
  },
  {
    name: "plugins",
    description: "Browse and install plugins",
    run(ctx) {
      return pluginsRun(ctx);
    },
  },
  {
    name: "effort",
    description: "Quick, normal or deep thinking",
    run(ctx, args) {
      return effortRun(ctx, args);
    },
  },
  {
    name: "export",
    description: "Save this chat to a file",
    run(ctx) {
      return exportRun(ctx);
    },
  },
  {
    name: "brain",
    description: "Open the Brain panel and notes",
    run(ctx) {
      return ctx.focusBrain();
    },
  },
  {
    name: "stop",
    description: "Stop the current job",
    run(ctx) {
      ctx.stop();
    },
  },
  {
    name: "clear",
    description: "Clear the view (chat stays)",
    run(ctx) {
      ctx.clearView();
    },
  },
];

export function findSlashCommand(name: string): SlashCommandDef | undefined {
  return SLASH_COMMANDS.find((def) => def.name === name);
}

async function resumeRun(ctx: SlashContext): Promise<void> {
  let sessions: ResumeSession[];
  try {
    sessions = await ctx.listSessions();
  } catch (error) {
    ctx.notice("error", `Couldn't list chats: ${commandErrorText(error)}.`);
    return;
  }
  if (sessions.length === 0) {
    ctx.notice("info", "No earlier chats in this folder yet.");
    return;
  }
  const now = Date.now();
  ctx.showCard(
    {
      title: "Earlier chats",
      body: sessions.map((session) => `- **${session.name}** — ${resumeDetail(session, now)}`).join("\n"),
      buttons: sessions.map((session) => ({ id: session.id, label: session.name.slice(0, 40) })),
    },
    {
      onButton: async (id) => {
        try {
          await ctx.switchToSession(id);
        } catch (error) {
          ctx.notice("error", `Couldn't switch chats: ${commandErrorText(error)}.`);
        }
      },
    },
  );
}

function resumeDetail(session: ResumeSession, now: number): string {
  const parsed = Date.parse(session.updatedAt);
  const when = formatUpdated(Number.isFinite(parsed) ? parsed : undefined, now);
  const turns = session.turnCount === 1 ? "1 turn" : `${session.turnCount} turns`;
  return `${when} · ${turns}`;
}

async function usageRun(ctx: SlashContext): Promise<void> {
  let info: UsageInfo;
  try {
    info = await ctx.readUsage();
  } catch (error) {
    ctx.notice("error", `Couldn't read usage: ${commandErrorText(error)}.`);
    return;
  }
  ctx.showCard({ title: "Usage", body: usageBody(info) });
}

function usageBody(info: UsageInfo): string {
  const lines: string[] = ["**This chat**"];
  if (info.session) {
    const session = info.session;
    let line = `${formatTokens(session.promptTokens)} tokens in · ${formatTokens(session.outputTokens)} out · ${formatTokens(session.totalTokens)} total`;
    if (session.usd !== undefined && session.usd > 0) {
      line += ` · ${formatCost(session.usd)} (estimate${session.partial ? ", partial" : ""})`;
    }
    lines.push(line);
  } else {
    lines.push("No usage yet — send a message first.");
  }
  lines.push("", "**Today, all chats**");
  let today = `${formatTokens(info.today.totalTokens)} tokens`;
  if (info.today.usd > 0) {
    today += ` · ${formatCost(info.today.usd)} (estimate)`;
  }
  lines.push(today);
  if (info.weekly || info.window) {
    lines.push("", "**Account**");
    if (info.weekly) {
      lines.push(
        `This week: ${info.weekly.usedPercent}% used · resets ${formatUpdated(info.weekly.resetsAtMs, Date.now())}.`,
      );
    }
    if (info.window) {
      lines.push(
        `Right now: ${info.window.usedPercent}% used · resets ${formatSaveTime(new Date(info.window.resetsAtMs))}.`,
      );
    }
  }
  lines.push("", `[Full usage on the Meta dashboard](${USAGE_DASHBOARD})`);
  return lines.join("\n");
}

function modelCard(models: ModelRow[]): CardSpec {
  const current = models.find((model) => model.active);
  const lines = current ? [`Now: **${current.label}**`] : ["Now: **unknown**"];
  if (current && /contributor/i.test(current.modelId)) {
    lines.push("", CONTRIBUTOR_WARNING);
  }
  return {
    title: "Model",
    body: lines.join("\n"),
    buttons: models.map((model) => ({
      id: model.modelId,
      label: `${model.label}${model.active ? " ✓" : ""}`.slice(0, 40),
    })),
  };
}

async function modelRun(ctx: SlashContext, args: string): Promise<void> {
  let models: ModelRow[];
  try {
    models = await ctx.listModels();
  } catch (error) {
    ctx.notice("error", `Couldn't list models: ${commandErrorText(error)}.`);
    return;
  }
  const want = args.trim();
  if (want !== "") {
    const match =
      models.find((model) => model.modelId === want) ??
      models.find((model) => model.modelId.toLowerCase() === want.toLowerCase());
    if (!match) {
      ctx.notice("info", `I can't see ${want} in the list.`);
      ctx.showCard(modelCard(models));
      return;
    }
    try {
      await ctx.setModel(match.modelId);
    } catch (error) {
      ctx.notice("error", `Couldn't switch models: ${commandErrorText(error)}.`);
      return;
    }
    ctx.notice("info", `Now using ${match.label}.`);
    return;
  }
  const id = ctx.showCard(modelCard(models), {
    onButton: async (modelId) => {
      try {
        await ctx.setModel(modelId);
        ctx.updateCard(id, modelCard(await ctx.listModels()));
      } catch (error) {
        ctx.notice("error", `Couldn't switch models: ${commandErrorText(error)}.`);
      }
    },
  });
}

async function compactRun(ctx: SlashContext): Promise<void> {
  try {
    const result = await ctx.compact();
    ctx.notice("info", result === "noop" ? "Nothing to tidy yet." : "Tidied up the chat history, kept the important bits.");
  } catch (error) {
    ctx.notice("error", `Couldn't tidy up: ${commandErrorText(error)}.`);
  }
}

async function recapRun(ctx: SlashContext): Promise<void> {
  const id = ctx.showCard({ title: "Recap", body: "Working…" });
  try {
    const recap = await ctx.recap();
    ctx.updateCard(id, {
      title: recap.title ? `Recap: ${recap.title.slice(0, 80)}` : "Recap",
      body: recap.text,
    });
  } catch (error) {
    ctx.updateCard(id, { title: "Recap", body: `Couldn't write a recap: ${commandErrorText(error)}.` });
  }
}

async function goalRun(ctx: SlashContext, args: string): Promise<void> {
  const clean = args.trim();
  if (clean === "") {
    const goal = ctx.currentGoal();
    if (!goal) {
      ctx.notice("info", "No goal pinned — /goal <text> to set one.");
      return;
    }
    ctx.showCard({ title: "Goal", body: goalBody(goal) });
    return;
  }
  const lower = clean.toLowerCase();
  if (lower === "pause" || lower === "resume" || lower === "clear") {
    const op = lower as "pause" | "resume" | "clear";
    const done = op === "pause" ? "Goal paused." : op === "resume" ? "Goal resumed." : "Goal cleared.";
    try {
      await ctx.goal(op);
      ctx.notice("info", done);
    } catch (error) {
      ctx.notice("error", `Couldn't ${op} the goal: ${commandErrorText(error)}.`);
    }
    return;
  }
  if (lower === "edit" || lower.startsWith("edit ")) {
    const text = clean.slice("edit".length).trim();
    if (text === "") {
      ctx.notice("info", "Tell me the new goal: /goal edit <text>.");
      return;
    }
    try {
      await ctx.goal("edit", text);
      ctx.notice("info", "Goal updated.");
    } catch (error) {
      ctx.notice("error", `Couldn't update the goal: ${commandErrorText(error)}.`);
    }
    return;
  }
  try {
    await ctx.goal("set", clean);
    ctx.notice("info", "Goal pinned.");
  } catch (error) {
    ctx.notice("error", `Couldn't pin the goal: ${commandErrorText(error)}.`);
  }
}

/** One short goal summary, shared by the /goal card and the pin. */
export function goalBody(goal: GoalInfo): string {
  const percent = Math.min(100, Math.max(0, Math.round(goal.percentComplete)));
  const lines = [`🎯 **${goal.objective}**`, `${percent}% · ${goal.status}`];
  const flow = [goal.currentWork, goal.nextWork].filter(
    (part): part is string => part !== undefined && part.trim() !== "",
  );
  if (flow.length > 0) {
    lines.push(flow.map((part) => part.trim()).join(" · "));
  }
  return lines.join("\n");
}

async function sideRun(ctx: SlashContext, args: string): Promise<void> {
  const question = args.trim();
  const ask = async (id: string, text: string): Promise<void> => {
    const lines: string[] = [];
    const showWorking = () =>
      ctx.updateCard(id, { title: "Side question", body: `**You:** ${text}\n\n${[...lines, "Working…"].join("\n")}` });
    showWorking();
    try {
      const answer = await ctx.sideAsk(text, (line) => {
        lines.push(line);
        showWorking();
      });
      ctx.updateCard(id, { title: "Side question", body: `**You:** ${text}\n\n${answer}` });
    } catch (error) {
      ctx.updateCard(id, {
        title: "Side question",
        body: `**You:** ${text}\n\nCouldn't answer that: ${commandErrorText(error)}.`,
      });
    }
  };
  if (question === "") {
    let boxId = "";
    boxId = ctx.showCard(
      {
        title: "Side question",
        body: "Ask something off-topic — the main chat stays as it is.",
        input: { id: "q", placeholder: "Ask anything…", buttonLabel: "Ask" },
      },
      { onInput: (text) => ask(boxId, text) },
    );
    return;
  }
  const id = ctx.showCard({ title: "Side question", body: `**You:** ${question}\n\nWorking…` });
  await ask(id, question);
}

async function forkRun(ctx: SlashContext): Promise<void> {
  try {
    await ctx.fork();
    ctx.notice("info", "Forked — trying another way from here. The old chat stays saved.");
  } catch (error) {
    ctx.notice("error", `Couldn't fork: ${commandErrorText(error)}.`);
  }
}

function tasksCard(tasks: TaskRow[]): CardSpec {
  if (tasks.length === 0) {
    return { title: "Running now", body: "Nothing running right now." };
  }
  return {
    title: "Running now",
    body: tasks.map((task) => `- **${task.label}** — ${task.detail}`).join("\n"),
    buttons: [
      ...tasks.map((task) => ({ id: `task:${task.taskId}`, label: `Stop ${task.label}`.slice(0, 40) })),
      { id: "all", label: "Stop all" },
    ],
  };
}

async function tasksRun(ctx: SlashContext): Promise<void> {
  let tasks: TaskRow[];
  try {
    tasks = await ctx.listTasks();
  } catch (error) {
    ctx.notice("error", `Couldn't list tasks: ${commandErrorText(error)}.`);
    return;
  }
  if (tasks.length === 0) {
    ctx.notice("info", "Nothing running right now.");
    return;
  }
  const refresh = async (id: string): Promise<void> => {
    try {
      ctx.updateCard(id, tasksCard(await ctx.listTasks()));
    } catch (error) {
      ctx.notice("error", `Couldn't list tasks: ${commandErrorText(error)}.`);
    }
  };
  const id = ctx.showCard(tasksCard(tasks), {
    onButton: async (buttonId) => {
      if (buttonId === "all") {
        try {
          await ctx.stopAllTasks();
          ctx.notice("info", "Stopped everything.");
          await refresh(id);
        } catch (error) {
          ctx.notice("error", `Couldn't stop them: ${commandErrorText(error)}.`);
        }
        return;
      }
      const taskId = buttonId.startsWith("task:") ? buttonId.slice("task:".length) : buttonId;
      try {
        await ctx.stopTask(taskId);
        ctx.notice("info", "Stopped it.");
        await refresh(id);
      } catch (error) {
        ctx.notice("error", `Couldn't stop it: ${commandErrorText(error)}.`);
      }
    },
  });
}

async function skillsRun(ctx: SlashContext): Promise<void> {
  let skills: SkillRow[];
  try {
    skills = await ctx.listSkills();
  } catch (error) {
    ctx.notice("error", `Couldn't list skills: ${commandErrorText(error)}.`);
    return;
  }
  if (skills.length === 0) {
    ctx.notice("info", "No skills installed.");
    return;
  }
  ctx.showCard(
    {
      title: "Skills",
      body: skills.map((skill) => `- **${skill.name}** — ${skill.description}`).join("\n"),
      buttons: skills.flatMap((skill) => [
        { id: `on:${skill.selector}`, label: `Turn on ${skill.name}`.slice(0, 40) },
        { id: `off:${skill.selector}`, label: `Turn off ${skill.name}`.slice(0, 40) },
      ]),
    },
    {
      onButton: async (buttonId) => {
        const on = buttonId.startsWith("on:");
        const selector = buttonId.slice(on ? "on:".length : "off:".length);
        const skill = skills.find((row) => row.selector === selector);
        try {
          await ctx.setSkill(selector, on);
          ctx.notice("info", `${skill?.name ?? selector} is now ${on ? "on" : "off"}.`);
        } catch (error) {
          ctx.notice("error", `Couldn't switch that skill: ${commandErrorText(error)}.`);
        }
      },
    },
  );
}

function pluginsCard(plugins: PluginRow[]): CardSpec {
  return {
    title: "Plugins",
    body:
      plugins.length === 0
        ? "No plugins installed yet."
        : plugins
            .map((plugin) => `- **${plugin.id}** — v${plugin.version} · ${plugin.enabled ? "on" : "off"}`)
            .join("\n"),
    input: { id: "install", placeholder: "store:name or folder path…", buttonLabel: "Install" },
  };
}

async function pluginsRun(ctx: SlashContext): Promise<void> {
  let plugins: PluginRow[];
  try {
    plugins = await ctx.listPlugins();
  } catch (error) {
    ctx.notice("error", `Couldn't list plugins: ${commandErrorText(error)}.`);
    return;
  }
  const id = ctx.showCard(pluginsCard(plugins), {
    onInput: async (text) => {
      if (!parsePluginSpec(text)) {
        ctx.notice("info", "Tell me the plugin as store:name, or a folder path.");
        return;
      }
      try {
        ctx.notice("info", await ctx.installPlugin(text.trim()));
        ctx.updateCard(id, pluginsCard(await ctx.listPlugins()));
      } catch (error) {
        ctx.notice("error", `Couldn't install it: ${commandErrorText(error)}.`);
      }
    },
  });
}

function effortCard(level: EffortLevel): CardSpec {
  return {
    title: "Thinking effort",
    body: `Now: **${EFFORT_LABELS[level]}**`,
    buttons: EFFORT_LEVELS.map((entry) => ({
      id: entry,
      label: `${EFFORT_LABELS[entry]}${entry === level ? " ✓" : ""}`,
    })),
  };
}

function parseEffort(args: string): EffortLevel | undefined {
  const want = args.trim().toLowerCase();
  return (EFFORT_LEVELS as string[]).includes(want) ? (want as EffortLevel) : undefined;
}

async function effortRun(ctx: SlashContext, args: string): Promise<void> {
  if (args.trim() === "") {
    const id = ctx.showCard(effortCard(ctx.currentEffort()), {
      onButton: async (buttonId) => {
        const level = parseEffort(buttonId);
        if (!level) {
          return;
        }
        try {
          await ctx.setEffort(level);
          ctx.updateCard(id, effortCard(level));
        } catch (error) {
          ctx.notice("error", `Couldn't set the effort: ${commandErrorText(error)}.`);
        }
      },
    });
    return;
  }
  const level = parseEffort(args);
  if (!level) {
    ctx.notice("info", "I know quick, normal or deep.");
    return;
  }
  try {
    await ctx.setEffort(level);
    ctx.notice("info", `Thinking: ${EFFORT_LABELS[level]}.`);
  } catch (error) {
    ctx.notice("error", `Couldn't set the effort: ${commandErrorText(error)}.`);
  }
}

async function exportRun(ctx: SlashContext): Promise<void> {
  try {
    const path = await ctx.exportHistory();
    if (path !== undefined) {
      ctx.notice("info", `Saved the chat to ${path}.`);
    }
  } catch (error) {
    ctx.notice("error", `Couldn't save the chat: ${commandErrorText(error)}.`);
  }
}

