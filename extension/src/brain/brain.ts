// The brain: Markdown files in the user's workspace that Muse reads every
// session. All file access goes through BrainFs so tests use a fake.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BrainFs {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  /** Modification time in ms, or undefined when the file is missing. */
  mtimeMs(path: string): Promise<number | undefined>;
}

export const nodeBrainFs: BrainFs = {
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  readFile: async (path) => {
    return readFile(path, "utf8");
  },
  writeFile: async (path, content) => {
    await writeFile(path, content, "utf8");
  },
  appendFile: async (path, content) => {
    await appendFile(path, content, "utf8");
  },
  mtimeMs: async (path) => {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return undefined;
    }
  },
};

const BRAIN_FILES: { file: string; template: string }[] = [
  {
    file: "me.md",
    template: `# About me

Who you are and how you like answers (short or full, plain words). The welcome chat fills this in — or just edit it.
`,
  },
  {
    file: "project.md",
    template: `## START HERE

What we're building, in a line or two. The welcome chat writes this with you.

## Updates

_Entries appear here, newest at the bottom, each tagged with its chat._
`,
  },
  {
    file: "tricks.md",
    template: `# Tricks

Workarounds that worked, one per line, newest first.
`,
  },
  {
    file: "good-for.md",
    template: `# Good for

Things Muse has actually done for you, in plain words. It grows as we work together.
`,
  },
];

/** Create the brain folder and starter files. Never overwrites anything. */
export async function ensureBrain(root: string, fs: BrainFs = nodeBrainFs): Promise<void> {
  const brainDir = join(root, "brain");
  await fs.mkdir(join(brainDir, "log"));
  for (const { file, template } of BRAIN_FILES) {
    const target = join(brainDir, file);
    if (!(await fs.exists(target))) {
      await fs.writeFile(target, template);
    }
  }
}

const FRONT_DOOR_START = "<!-- meta-betta:start -->";
const FRONT_DOOR_END = "<!-- meta-betta:end -->";

export const FRONT_DOOR_SECTION = `<!-- meta-betta:start -->
## Meta Betta brain (read first, every session)
1. Read brain/me.md, brain/project.md (START HERE plus the last 10 entries under Updates), brain/tricks.md and today's brain/log file if it exists.
2. Open your first reply with "Here's where we're up to:" and 2–3 plain lines from the latest updates, then ask what we're doing today. If the user says "continue working on X", use the latest entries about X and carry on from there.
3. Talk to the user the way brain/me.md says. Plain English, no jargon.
4. Before building, propose the simplest version in one or two lines and wait for a yes.
5. When something fails, try 2–3 other ways before giving up, and say plainly which one worked. Mention any workaround that worked, and it gets saved to brain/tricks.md when we save.
6. Finish every job with: what you did (plain words), how to use it (click by click), anything you couldn't check.
7. Never edit files outside this workspace.
8. Never rewrite or delete anything in brain/. The brain only grows; the extension adds new entries for you when we save.
<!-- meta-betta:end -->`;

/**
 * Make sure the workspace AGENTS.md carries our front-door section: create
 * the file when missing, append the section when it has no markers, replace
 * only the marked section on later runs. Never touches anything else.
 */
export async function ensureFrontDoor(root: string, fs: BrainFs = nodeBrainFs): Promise<void> {
  const target = join(root, "AGENTS.md");
  if (!(await fs.exists(target))) {
    await fs.writeFile(target, `${FRONT_DOOR_SECTION}\n`);
    return;
  }
  const content = await fs.readFile(target);
  const start = content.indexOf(FRONT_DOOR_START);
  const end = start === -1 ? -1 : content.indexOf(FRONT_DOOR_END, start);
  if (start === -1 || end === -1) {
    // No complete section: append a fresh one and keep everything else.
    await fs.writeFile(target, `${content.replace(/\n*$/, "")}\n\n${FRONT_DOOR_SECTION}\n`);
    return;
  }
  const after = end + FRONT_DOOR_END.length;
  await fs.writeFile(target, `${content.slice(0, start)}${FRONT_DOOR_SECTION}${content.slice(after)}`);
}

/** `### 2026-10-28 09:41 · Session 7f3a · login page` (local time). */
export function entryHeading(now: Date, sessionLabel: string): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `### ${date} ${time} · ${sessionLabel}`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/**
 * Add one entry to the end of a brain file. A plain append — never
 * read-modify-write — so two windows saving at once can't wipe each other.
 * `file` is relative to brain/, e.g. "project.md" or "log/2026-10-28.md".
 */
export async function appendEntry(
  root: string,
  file: string,
  sessionLabel: string,
  text: string,
  fs: BrainFs = nodeBrainFs,
  now: Date = new Date(),
): Promise<void> {
  const target = join(root, "brain", file);
  await fs.appendFile(target, `\n${entryHeading(now, sessionLabel)}\n\n${text.trim()}\n`);
}

/** Today's log file, relative to brain/, e.g. "log/2026-10-28.md". */
export function todayLogFile(now: Date = new Date()): string {
  return `log/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`;
}

/** Short random id for a chat session label, e.g. "7f3a". */
export function createSessionId(): string {
  return randomBytes(2).toString("hex");
}

const TOPIC_LIMIT = 40;

/** Clean a topic for display: one line, bounded. */
export function cleanTopic(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TOPIC_LIMIT);
}

/**
 * The topic declared by "continue working on X", or undefined for any other
 * message. Always re-declares the chat's topic, even mid-conversation.
 */
export function continuedTopic(text: string): string | undefined {
  const clean = text.replace(/\s+/g, " ").trim();
  const match = clean.match(/^continue working on (.+)$/i);
  if (!match) {
    return undefined;
  }
  const topic = match[1].trim().replace(/[.?…]+$/, "").slice(0, TOPIC_LIMIT);
  return topic === "" ? undefined : topic;
}

/**
 * The chat's topic from its first message: "continue working on X" names X,
 * otherwise the first line, bounded.
 */
export function topicFromFirstMessage(text: string): string {
  return (
    continuedTopic(text) ?? text.replace(/\s+/g, " ").trim().replace(/[.?…]+$/, "").slice(0, TOPIC_LIMIT)
  );
}

/** `Session 7f3a · login page`, or `Session 7f3a` before the topic is known. */
export function formatSessionLabel(id: string, topic: string): string {
  return topic ? `Session ${id} · ${topic}` : `Session ${id}`;
}

export interface StoredSessionLabel {
  id: string;
  topic: string;
}

/** Validate a stored session label; anything else is forgotten. */
export function cleanSessionLabel(value: unknown): StoredSessionLabel | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const label = value as { id?: unknown; topic?: unknown };
  if (typeof label.id !== "string" || !label.id.trim() || typeof label.topic !== "string") {
    return undefined;
  }
  return { id: label.id, topic: label.topic };
}

export interface BrainCardInput {
  file: string;
  title: string;
  mtimeMs: number | undefined;
  content: string | undefined;
}

export interface BrainCard {
  file: string;
  title: string;
  updated: string;
  excerpt: string;
}

const BRAIN_CARDS: { file: string; title: string }[] = [
  { file: "me.md", title: "About you" },
  { file: "project.md", title: "Project" },
  { file: "tricks.md", title: "Tricks" },
  { file: "good-for.md", title: "Good for" },
];

/** Card inputs for the brain panel: the four files plus today's log. */
export function brainCardInputs(
  read: (file: string) => { mtimeMs: number | undefined; content: string | undefined },
  now: Date = new Date(),
): BrainCardInput[] {
  const inputs = BRAIN_CARDS.map(({ file, title }) => ({ file, title, ...read(file) }));
  const logFile = todayLogFile(now);
  inputs.push({ file: logFile, title: "Today's log", ...read(logFile) });
  return inputs;
}

/** Friendly cards for the brain panel. */
export function buildBrainCards(inputs: BrainCardInput[], nowMs: number = Date.now()): BrainCard[] {
  return inputs.map((input) => ({
    file: input.file,
    title: input.title,
    updated: input.content === undefined ? "Nothing here yet" : formatUpdated(input.mtimeMs, nowMs),
    excerpt:
      input.content === undefined
        ? "Nothing here yet."
        : input.file === "project.md"
          ? startHereSection(input.content)
          : firstLines(input.content, 6),
  }));
}

function firstLines(content: string, count: number): string {
  const lines = content.split("\n");
  let first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) {
    return "";
  }
  // Skip a leading "# heading" line; the card already shows the title.
  if (/^#{1,6}\s/.test(lines[first] ?? "")) {
    const afterHeading = lines.findIndex((line, index) => index > first && line.trim() !== "");
    if (afterHeading === -1) {
      return "";
    }
    first = afterHeading;
  }
  return lines.slice(first, first + count).join("\n").trim();
}

/** The START HERE section of project.md (up to the next heading). */
export function startHereSection(content: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## START HERE");
  if (start === -1) {
    return firstLines(content, 6);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("## "));
  const section = (end === -1 ? rest : rest.slice(0, end)).join("\n");
  return firstLines(section, 6);
}

/** "Today, 2:15pm", "Yesterday" or "28 Oct". */
export function formatUpdated(mtimeMs: number | undefined, nowMs: number): string {
  if (mtimeMs === undefined) {
    return "Never";
  }
  const updated = new Date(mtimeMs);
  const now = new Date(nowMs);
  const day = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (day(updated) === day(now)) {
    const hour24 = updated.getHours();
    const meridiem = hour24 < 12 ? "am" : "pm";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `Today, ${hour12}:${pad(updated.getMinutes())}${meridiem}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(updated) === day(yesterday)) {
    return "Yesterday";
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = updated.getFullYear() === now.getFullYear() ? "" : ` ${updated.getFullYear()}`;
  return `${updated.getDate()} ${months[updated.getMonth()]}${year}`;
}
