import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEntry,
  backupBrain,
  brainCardInputs,
  buildBackgroundBlock,
  buildBrainCards,
  catchUpGreeting,
  cleanLiveLabels,
  cleanSessionLabel,
  cleanTopic,
  continuedTopic,
  createSessionId,
  ensureBrain,
  ensureFrontDoor,
  ensureGitignoreEntry,
  entryHeading,
  formatSaveTime,
  formatSessionLabel,
  formatUpdated,
  FRONT_DOOR_SECTION,
  greetingName,
  isBackupTargetSafe,
  isLabelTaken,
  isStarterMe,
  LIVE_LABEL_TTL_MS,
  needsCatchUp,
  splitSaveReply,
  startHereSection,
  stripBackgroundPrefix,
  todayLogFile,
  topicFromFirstMessage,
  tricksPreview,
  UnsafeBackupError,
  welcomeName,
  withNameLine,
  withStartHere,
  type BackupOps,
  type BrainFs,
} from "../brain/brain.js";
import {
  isSavePrompt,
  QUICK_SAVE_PROMPT,
  SAVE_MY_DAY_PROMPT,
  WELCOME_MEMORY_DETAIL,
  WELCOME_MEMORY_TEXT,
  WELCOME_PROMPT,
} from "../brain/prompts.js";

/** In-memory file system. Yields between steps so races interleave. */
function fakeFs(): BrainFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    files,
    exists: async (path) => files.has(path),
    mkdir: async () => undefined,
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`missing: ${path}`);
      }
      return content;
    },
    writeFile: async (path, content) => {
      await tick();
      files.set(path, content);
    },
    appendFile: async (path, content) => {
      await tick();
      files.set(path, (files.get(path) ?? "") + content);
    },
    mtimeMs: async (path) => (files.has(path) ? 1000 : undefined),
  };
}

const when = new Date(2026, 9, 28, 9, 41);

describe("ensureBrain", () => {
  it("creates the folder files with starter templates", async () => {
    const fs = fakeFs();
    await ensureBrain("root", fs);

    const project = fs.files.get(join("root", "brain", "project.md"));
    assert.ok(project?.startsWith("## START HERE"));
    assert.ok(project?.includes("## Updates"));
    assert.ok(fs.files.has(join("root", "brain", "me.md")));
    assert.ok(fs.files.has(join("root", "brain", "tricks.md")));
    assert.ok(fs.files.has(join("root", "brain", "good-for.md")));
  });

  it("never overwrites existing files", async () => {
    const fs = fakeFs();
    await ensureBrain("root", fs);
    for (const [path, content] of fs.files) {
      fs.files.set(path, `mine: ${content}`);
    }
    await ensureBrain("root", fs);
    for (const [path, content] of fs.files) {
      assert.ok(content.startsWith("mine: "), path);
    }
  });
});

describe("ensureFrontDoor", () => {
  it("creates AGENTS.md from the template when missing", async () => {
    const fs = fakeFs();
    await ensureFrontDoor("root", fs);

    const content = [...fs.files.values()][0];
    assert.ok(content.startsWith("<!-- meta-betta:start -->"));
    assert.ok(content.includes("## Meta Betta brain (read first, every session)"));
    assert.ok(content.includes("Mention any workaround that worked, and it gets saved to brain/tricks.md when we save."));
    assert.ok(!content.includes("Add any workaround that worked to brain/tricks.md."));
    assert.ok(content.trimEnd().endsWith("<!-- meta-betta:end -->"));
  });

  it("appends the section when there are no markers", async () => {
    const fs = fakeFs();
    const target = join("root", "AGENTS.md");
    fs.files.set(target, "# Ours\n\nBe kind.\n");
    await ensureFrontDoor("root", fs);

    const content = fs.files.get(target) ?? "";
    assert.ok(content.startsWith("# Ours\n\nBe kind.\n"));
    assert.ok(content.includes(FRONT_DOOR_SECTION));
  });

  it("replaces only the marked section on later runs", async () => {
    const fs = fakeFs();
    const target = join("root", "AGENTS.md");
    fs.files.set(target, `# Ours\n\n${FRONT_DOOR_SECTION.replace("every session", "OLD")}\n\nTail.\n`);
    await ensureFrontDoor("root", fs);

    const content = fs.files.get(target) ?? "";
    assert.ok(!content.includes("OLD"));
    assert.ok(content.includes(FRONT_DOOR_SECTION));
    assert.ok(content.startsWith("# Ours\n"));
    assert.ok(content.endsWith("Tail.\n"));
  });

  it("appends a fresh section when the end marker is missing, keeping everything", async () => {
    const fs = fakeFs();
    const target = join("root", "AGENTS.md");
    const broken = "# Ours\n\n<!-- meta-betta:start -->\nHalf a section.\n\nTail.\n";
    fs.files.set(target, broken);
    await ensureFrontDoor("root", fs);

    const content = fs.files.get(target) ?? "";
    assert.ok(content.startsWith(broken.replace(/\n*$/, "")));
    assert.ok(content.includes(FRONT_DOOR_SECTION));
    assert.ok(content.includes("Tail."));
  });

  it("is a no-op when the section is already current", async () => {
    const fs = fakeFs();
    const target = join("root", "AGENTS.md");
    const current = `# Ours\n\n${FRONT_DOOR_SECTION}\n`;
    fs.files.set(target, current);
    await ensureFrontDoor("root", fs);

    assert.equal(fs.files.get(target), current);
  });
});

describe("appendEntry", () => {
  it("adds a headed entry to the end, leaving earlier text alone", async () => {
    const fs = fakeFs();
    await ensureBrain("root", fs);
    const key = [...fs.files.keys()].find((path) => path.endsWith("project.md")) ?? "";
    const before = fs.files.get(key) ?? "";

    await appendEntry("root", "project.md", "Session 7f3a · login page", "Did the thing.", fs, when);

    const after = fs.files.get(key) ?? "";
    assert.ok(after.startsWith(before));
    assert.ok(after.includes("### 2026-10-28 09:41 · Session 7f3a · login page\n\nDid the thing.\n"));
  });

  it("keeps both entries when two appends race", async () => {
    const fs = fakeFs();
    await Promise.all([
      appendEntry("root", "project.md", "Session aaaa · one", "First.", fs, when),
      appendEntry("root", "project.md", "Session bbbb · two", "Second.", fs, when),
    ]);

    const key = [...fs.files.keys()].find((path) => path.endsWith("project.md")) ?? "";
    const content = fs.files.get(key) ?? "";
    assert.ok(content.includes("First."));
    assert.ok(content.includes("Second."));
  });
});

describe("entryHeading", () => {
  it("words the heading with local date, time and label", () => {
    assert.equal(entryHeading(when, "Session 7f3a · login page"), "### 2026-10-28 09:41 · Session 7f3a · login page");
  });
});

describe("todayLogFile", () => {
  it("names today's log file", () => {
    assert.equal(todayLogFile(when), "log/2026-10-28.md");
  });
});

describe("session labels", () => {
  it("creates short hex ids", () => {
    assert.match(createSessionId(), /^[0-9a-f]{4}$/);
  });

  it("takes the topic from the first message", () => {
    assert.equal(topicFromFirstMessage("Fix the login page crash"), "Fix the login page crash");
    assert.equal(topicFromFirstMessage("continue working on the login page"), "the login page");
    assert.equal(topicFromFirstMessage("Continue Working On X..."), "X");
    assert.equal(topicFromFirstMessage("x".repeat(100)).length, 40);
  });

  it("cleans rename input", () => {
    assert.equal(cleanTopic("  my  topic "), "my topic");
    assert.equal(cleanTopic(""), "");
  });

  it("reads continued topics, or nothing", () => {
    assert.equal(continuedTopic("continue working on the login page"), "the login page");
    assert.equal(continuedTopic("Continue Working On X..."), "X");
    assert.equal(continuedTopic("fix the login page"), undefined);
    assert.equal(continuedTopic("continue working on ..."), undefined);
  });

  it("formats the label with or without a topic", () => {
    assert.equal(formatSessionLabel("7f3a", "login page"), "Session 7f3a · login page");
    assert.equal(formatSessionLabel("7f3a", ""), "Session 7f3a");
  });
});

describe("brain cards", () => {
  it("builds five cards including today's log", () => {
    const inputs = brainCardInputs(() => ({ mtimeMs: 1000, content: "hello" }), when);
    assert.equal(inputs.length, 5);
    assert.equal(inputs[4]?.file, "log/2026-10-28.md");
    assert.equal(inputs[4]?.title, "Today's log");
  });

  it("shows the START HERE section for project.md", () => {
    const [card] = buildBrainCards(
      [
        {
          file: "project.md",
          title: "Project",
          mtimeMs: 1000,
          content: "## START HERE\n\nWe build widgets.\n\n## Updates\n\nOld news.\n",
        },
      ],
      2000,
    );
    assert.equal(card?.excerpt, "We build widgets.");
  });

  it("shows the first lines of other files", () => {
    const [card] = buildBrainCards(
      [{ file: "tricks.md", title: "Tricks", mtimeMs: 1000, content: "# Tricks\n\nRestart it.\n\nTwice.\n" }],
      2000,
    );
    assert.equal(card?.excerpt, "Restart it.\n\nTwice.");
  });

  it("skips a leading heading but keeps hashtag text", () => {
    const [headed, tagged] = buildBrainCards(
      [
        { file: "me.md", title: "About you", mtimeMs: 1000, content: "## Me\n\nHi.\n" },
        { file: "me.md", title: "About you", mtimeMs: 1000, content: "#lobby\n\nHi.\n" },
      ],
      2000,
    );
    assert.equal(headed?.excerpt, "Hi.");
    assert.equal(tagged?.excerpt, "#lobby\n\nHi.");
  });

  it("marks missing files", () => {
    const [card] = buildBrainCards([{ file: "me.md", title: "About you", mtimeMs: undefined, content: undefined }]);
    assert.equal(card?.updated, "Nothing here yet");
    assert.equal(card?.excerpt, "Nothing here yet.");
  });
});

describe("startHereSection", () => {
  it("falls back to the first lines without the heading", () => {
    assert.equal(startHereSection("# Nope\n\nJust text.\n"), "Just text.");
  });
});

describe("buildBackgroundBlock", () => {
  const project = [
    "## START HERE",
    "",
    "We build widgets.",
    "",
    "## Updates",
    "",
    "### 2026-10-26 09:00 · Session aaaa · one",
    "",
    "First update.",
    "",
    "### 2026-10-27 09:00 · Session bbbb · two",
    "",
    "Second update.",
    "",
  ].join("\n");

  it("marks the brain as background with the opening note", () => {
    const block = buildBackgroundBlock({ me: "I'm Bryan.", project, tricks: "Restart it.", todayLog: "Did things." });
    assert.ok(block.startsWith("[Background:"));
    assert.ok(block.includes("Open with 'Here's where we're up to:' from this. No need to read the brain files."));
    assert.ok(block.includes("Remember rule 9: back up a file to .backups/ before changing it."));
    assert.ok(block.includes("## About you\nI'm Bryan."));
    assert.ok(block.includes("## Project: START HERE\nWe build widgets."));
    assert.ok(block.includes("## Latest updates\n### 2026-10-26 09:00 · Session aaaa · one\n\nFirst update."));
    assert.ok(block.includes("## Tricks\nRestart it."));
    assert.ok(block.includes("## Today's log\nDid things."));
    assert.ok(block.endsWith("[End of background.]"));
  });

  it("skips missing files and empty sections", () => {
    assert.equal(buildBackgroundBlock({}), "");
    assert.equal(buildBackgroundBlock({ me: "", tricks: "  \n " }), "");
    const block = buildBackgroundBlock({
      me: "I'm Bryan.",
      project: "## START HERE\n\nWidgets.\n",
      todayLog: "",
    });
    assert.ok(!block.includes("## Latest updates"));
    assert.ok(!block.includes("## Today's log"));
    assert.ok(block.includes("Widgets."));
  });

  it("keeps only the newest 10 updates", () => {
    const entries = Array.from(
      { length: 12 },
      (_, index) => `### 2026-10-28 09:${String(index).padStart(2, "0")} · Session x · ${index}\n\nUpdate ${index}.`,
    );
    const block = buildBackgroundBlock({ project: `## START HERE\n\nX.\n\n## Updates\n\n${entries.join("\n\n")}\n` });
    assert.ok(!block.includes("Update 0."));
    assert.ok(!block.includes("Update 1."));
    assert.ok(block.includes("Update 2."));
    assert.ok(block.includes("Update 11."));
  });

  it("stays within budget on a fat brain, newest updates kept", () => {
    const fat = "x".repeat(5000);
    const entries = Array.from({ length: 10 }, (_, index) => `### 2026-10-28 · ${index}\n\n${"y".repeat(1000)}`);
    const block = buildBackgroundBlock({
      me: fat,
      project: `## START HERE\n\n${fat}\n\n## Updates\n\n${entries.join("\n\n")}\n`,
      tricks: fat,
      todayLog: fat,
    });
    assert.ok(block.length <= 8000, `block is ${block.length} chars`);
    assert.ok(block.includes("### 2026-10-28 · 9"), "newest update kept");
  });
});

describe("stripBackgroundPrefix", () => {
  it("removes the block from a resumed user message", () => {
    const block = buildBackgroundBlock({ me: "I'm Bryan." });
    const combined = `${block}\n\nhello there`;
    assert.equal(stripBackgroundPrefix(combined), "hello there");
  });

  it("leaves plain messages and broken markers alone", () => {
    assert.equal(stripBackgroundPrefix("hello"), "hello");
    assert.equal(stripBackgroundPrefix("[Background: oops"), "[Background: oops");
  });
});

describe("greetingName", () => {
  it("finds a first name", () => {
    assert.equal(greetingName("I'm Bryan, a backend dev."), "Bryan");
    assert.equal(greetingName("My name is ana."), "Ana");
    assert.equal(greetingName("Call me jo."), "Jo");
  });

  it("skips articles and template text", () => {
    assert.equal(greetingName("I am a developer. I'm Bryan."), "Bryan");
    assert.equal(greetingName("Who you are and how you like answers."), undefined);
    assert.equal(greetingName(undefined), undefined);
    assert.equal(greetingName(""), undefined);
  });

  it("reads a Name: line first", () => {
    assert.equal(greetingName("# About me\n\nName: Bryan\n"), "Bryan");
    assert.equal(greetingName("Name: ana"), "Ana");
    assert.equal(greetingName("Name: \nI'm Bryan."), "Bryan");
  });
});

describe("welcome filing", () => {
  it("spots a starter me.md", () => {
    assert.equal(
      isStarterMe("# About me\n\nWho you are and how you like answers (short or full, plain words). The welcome chat fills this in — or just edit it.\n"),
      true,
    );
    assert.equal(isStarterMe("# About me\n\nName: Bryan\n"), false);
    assert.equal(isStarterMe(undefined), true);
  });

  it("appends one Name: line, never two", () => {
    assert.equal(withNameLine("# About me\n", "Bryan"), "# About me\n\nName: Bryan\n");
    assert.equal(withNameLine("# About me\n\nName: Bryan\n", "Ana"), "# About me\n\nName: Bryan\n");
  });

  it("writes the START HERE section and keeps the rest", () => {
    assert.equal(
      withStartHere("## START HERE\n\nOld.\n\n## Updates\n\n- x\n", "A todo app."),
      "## START HERE\n\nA todo app.\n\n## Updates\n\n- x\n",
    );
    assert.equal(withStartHere("## Updates\n\n- x\n", "A todo app."), "## START HERE\n\nA todo app.\n\n## Updates\n\n- x\n");
    assert.equal(withStartHere("## START HERE\n\nOld.", "New."), "## START HERE\n\nNew.\n");
    assert.equal(withStartHere("## START HERE\n\nOld.\n", "  "), "## START HERE\n\nOld.\n");
  });

  it("takes a name from a welcome answer", () => {
    assert.equal(welcomeName("Bryan"), "Bryan");
    assert.equal(welcomeName("bob smith"), "Bob smith");
    assert.equal(welcomeName("I'm Bryan."), "Bryan");
    assert.equal(welcomeName("call me Al"), "Al");
  });

  it("leaves refusals and rambles alone", () => {
    assert.equal(welcomeName("no thanks"), undefined);
    assert.equal(welcomeName("I'd rather not say"), undefined);
    assert.equal(welcomeName("don't call me anything"), undefined);
    assert.equal(welcomeName("well that depends what you mean by name"), undefined);
    assert.equal(welcomeName(""), undefined);
  });
});

describe("catchUpGreeting", () => {
  it("picks the part of day by the clock", () => {
    assert.ok(catchUpGreeting(new Date(2026, 9, 28, 5, 0), undefined).startsWith("Good morning,"));
    assert.ok(catchUpGreeting(new Date(2026, 9, 28, 11, 59), undefined).startsWith("Good morning,"));
    assert.ok(catchUpGreeting(new Date(2026, 9, 28, 12, 0), undefined).startsWith("Good afternoon,"));
    assert.ok(catchUpGreeting(new Date(2026, 9, 28, 17, 59), undefined).startsWith("Good afternoon,"));
    assert.ok(catchUpGreeting(new Date(2026, 9, 28, 18, 0), undefined).startsWith("Good evening,"));
    assert.ok(catchUpGreeting(new Date(2026, 9, 28, 4, 59), undefined).startsWith("Good evening,"));
  });

  it("names the user when me.md has a name", () => {
    assert.equal(
      catchUpGreeting(new Date(2026, 9, 28, 9, 0), "I'm Bryan."),
      "Good morning Bryan, hold on a sec while I catch up…",
    );
    assert.equal(
      catchUpGreeting(new Date(2026, 9, 28, 9, 0), undefined),
      "Good morning, hold on a sec while I catch up…",
    );
  });
});

describe("needsCatchUp", () => {
  const noon = new Date(2026, 9, 28, 12, 0).getTime();
  const hour = 3_600_000;

  it("catches up after an earlier day or more than 4 hours", () => {
    assert.equal(needsCatchUp(new Date(2026, 9, 27, 23, 0).getTime(), noon, 4), true);
    assert.equal(needsCatchUp(noon - 4 * hour - 1, noon, 4), true);
    assert.equal(needsCatchUp(noon - 4 * hour, noon, 4), false);
    assert.equal(needsCatchUp(noon - 60_000, noon, 4), false);
  });

  it("catches up across midnight even within the hours", () => {
    const halfPastMidnight = new Date(2026, 9, 28, 0, 30).getTime();
    assert.equal(needsCatchUp(new Date(2026, 9, 27, 23, 45).getTime(), halfPastMidnight, 4), true);
  });

  it("honours the setting", () => {
    assert.equal(needsCatchUp(noon - 2 * hour, noon, 1), true);
    assert.equal(needsCatchUp(noon - 2 * hour, noon, 8), false);
  });

  it("catches up when unknown, never for the future", () => {
    assert.equal(needsCatchUp(undefined, noon, 4), true);
    assert.equal(needsCatchUp(noon + hour, noon, 4), false);
  });
});

describe("cleanSessionLabel", () => {
  it("accepts a well-formed label", () => {
    assert.deepEqual(cleanSessionLabel({ id: "7f3a", topic: "login page" }), { id: "7f3a", topic: "login page" });
    assert.deepEqual(cleanSessionLabel({ id: "7f3a", topic: "" }), { id: "7f3a", topic: "" });
  });

  it("forgets anything else", () => {
    assert.equal(cleanSessionLabel(undefined), undefined);
    assert.equal(cleanSessionLabel({}), undefined);
    assert.equal(cleanSessionLabel({ id: "", topic: "x" }), undefined);
    assert.equal(cleanSessionLabel({ id: "7f3a" }), undefined);
  });
});

describe("formatUpdated", () => {
  it("words today, yesterday and older dates", () => {
    const noon = new Date(2026, 9, 28, 14, 15).getTime();
    assert.equal(formatUpdated(new Date(2026, 9, 28, 9, 5).getTime(), noon), "Today, 9:05am");
    assert.equal(formatUpdated(new Date(2026, 9, 27, 23, 59).getTime(), noon), "Yesterday");
    assert.equal(formatUpdated(new Date(2026, 9, 1).getTime(), noon), "1 Oct");
    assert.equal(formatUpdated(new Date(2025, 11, 25).getTime(), noon), "25 Dec 2025");
    assert.equal(formatUpdated(undefined, noon), "Never");
  });
});

describe("splitSaveReply", () => {
  it("splits a full reply into its five sections", () => {
    const sections = splitSaveReply(
      "## project\n- Works.\n\n## log\n- Did things.\n\n## tricks\n- Restart it.\n\n## good-for\n- Read a photo.\n\n## me\n- Likes short answers.\n",
    );
    assert.deepEqual(sections, {
      project: "- Works.",
      log: "- Did things.",
      tricks: "- Restart it.",
      "good-for": "- Read a photo.",
      me: "- Likes short answers.",
    });
  });

  it("tolerates missing sections, odd cases and repeats", () => {
    const sections = splitSaveReply("## Project\n- Works.\n\n## GOOD FOR\n- Read a photo.\n\n## project\n- More.\n");
    assert.deepEqual(sections, { project: "- Works.\n\n- More.", "good-for": "- Read a photo." });
  });

  it("skips unknown headings and empty sections", () => {
    assert.deepEqual(splitSaveReply("## project\n- Works.\n\n## feelings\n- Tired.\n"), { project: "- Works." });
    assert.deepEqual(splitSaveReply("## project\n\n## log\n- Did things.\n"), { log: "- Did things." });
    assert.deepEqual(splitSaveReply(""), {});
    assert.deepEqual(splitSaveReply("No headings here."), {});
  });
});

describe("save prompts", () => {
  it("recognises its own prompts and nothing else", () => {
    assert.equal(isSavePrompt(SAVE_MY_DAY_PROMPT), true);
    assert.equal(isSavePrompt(QUICK_SAVE_PROMPT), true);
    assert.equal(isSavePrompt("Save my day please"), false);
    assert.equal(isSavePrompt(""), false);
  });
});

describe("welcome words", () => {
  it("asks the name, then the project, one per reply", () => {
    assert.ok(WELCOME_PROMPT.includes(`"G'day! What should I call you?"`));
    assert.ok(WELCOME_PROMPT.includes(`"What are we working on in this folder?"`));
    assert.ok(WELCOME_PROMPT.includes("Don't edit any files."));
  });

  it("memory message links the Brain panel and Save my day", () => {
    assert.ok(WELCOME_MEMORY_TEXT.includes("`brain/`"));
    assert.ok(WELCOME_MEMORY_TEXT.includes("Save my day"));
    assert.ok(WELCOME_MEMORY_TEXT.includes("Here's where we're up to"));
  });

  it("detail says where the brain lives and what stays out of it", () => {
    assert.ok(WELCOME_MEMORY_DETAIL.includes("stored in this project, on your machine"));
    assert.ok(WELCOME_MEMORY_DETAIL.includes("backup folder in Settings"));
    assert.ok(WELCOME_MEMORY_DETAIL.includes("keep passwords and keys out of it"));
  });
});

describe("formatSaveTime", () => {
  it("words the time like 2:15pm", () => {
    assert.equal(formatSaveTime(new Date(2026, 9, 28, 14, 15)), "2:15pm");
    assert.equal(formatSaveTime(new Date(2026, 9, 28, 9, 5)), "9:05am");
    assert.equal(formatSaveTime(new Date(2026, 9, 28, 0, 1)), "12:01am");
    assert.equal(formatSaveTime(new Date(2026, 9, 28, 12, 0)), "12:00pm");
  });
});

describe("backupBrain", () => {
  it("copies brain/ over the old backup", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "meta-betta-backup-"));
    try {
      const root = join(sandbox, "work");
      const backupFolder = join(sandbox, "backups");
      await mkdir(join(root, "brain", "log"), { recursive: true });
      await mkdir(backupFolder, { recursive: true });
      await writeFile(join(root, "brain", "project.md"), "new", "utf8");
      await writeFile(join(root, "brain", "log", "2026-10-28.md"), "today", "utf8");
      // A stale file from an earlier backup must not survive.
      await mkdir(join(backupFolder, "work", "brain"), { recursive: true });
      await writeFile(join(backupFolder, "work", "brain", "stale.md"), "old", "utf8");
      await backupBrain(root, backupFolder);
      assert.equal(await readFile(join(backupFolder, "work", "brain", "project.md"), "utf8"), "new");
      assert.equal(await readFile(join(backupFolder, "work", "brain", "log", "2026-10-28.md"), "utf8"), "today");
      await assert.rejects(readFile(join(backupFolder, "work", "brain", "stale.md"), "utf8"));
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("throws when the backup folder is missing", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "meta-betta-backup-"));
    try {
      await mkdir(join(sandbox, "work", "brain"), { recursive: true });
      await assert.rejects(backupBrain(join(sandbox, "work"), join(sandbox, "nowhere")));
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("refuses targets that would endanger the live brain, deleting nothing", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "meta-betta-backup-"));
    try {
      const root = join(sandbox, "work");
      await mkdir(join(root, "brain"), { recursive: true });
      await writeFile(join(root, "brain", "project.md"), "live", "utf8");
      const dangerous = [
        sandbox, // parent of workspace: target IS the live brain
        join(root, "backups"), // backup folder inside the workspace
        root, // same folder
        join(root, "brain", "sub"), // backup folder inside the live brain
      ];
      for (const backupFolder of dangerous) {
        await assert.rejects(backupBrain(root, backupFolder), UnsafeBackupError);
      }
      assert.equal(await readFile(join(root, "brain", "project.md"), "utf8"), "live");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("a copy that fails halfway leaves the old backup alone", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "meta-betta-backup-"));
    try {
      const root = join(sandbox, "work");
      const backupFolder = join(sandbox, "backups");
      await mkdir(join(root, "brain"), { recursive: true });
      await mkdir(join(backupFolder, "work", "brain"), { recursive: true });
      await writeFile(join(root, "brain", "project.md"), "new", "utf8");
      await writeFile(join(backupFolder, "work", "brain", "project.md"), "old", "utf8");
      const real: BackupOps = { stat, mkdir, rm, cp, rename };
      const failing: BackupOps = {
        ...real,
        cp: async (src, dest) => {
          await real.cp(src, dest, { recursive: true });
          throw new Error("disk full halfway");
        },
      };
      await assert.rejects(backupBrain(root, backupFolder, failing), /disk full halfway/);
      assert.equal(await readFile(join(backupFolder, "work", "brain", "project.md"), "utf8"), "old");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("isBackupTargetSafe", () => {
  it("refuses the live brain, the workspace and anything nested either way", () => {
    const sandbox = join(tmpdir(), "meta-betta-targets");
    const root = join(sandbox, "work");
    assert.equal(isBackupTargetSafe(root, sandbox), false); // target is the live brain
    assert.equal(isBackupTargetSafe(root, join(root, "backups")), false); // inside the workspace
    assert.equal(isBackupTargetSafe(root, root), false); // same folder
    assert.equal(isBackupTargetSafe(join(sandbox, "sub", "brain", "sub"), sandbox), false); // contains it
    assert.equal(isBackupTargetSafe(join(sandbox, "brain", "brain"), sandbox), false); // is the workspace
    assert.equal(isBackupTargetSafe(root, join(sandbox, "backups")), true);
    assert.equal(isBackupTargetSafe(root, join("..", "backups")), true); // relative counts from the workspace
    assert.equal(isBackupTargetSafe(root, "."), false);
  });

  it("compares case-insensitively on Windows", { skip: process.platform !== "win32" }, () => {
    assert.equal(isBackupTargetSafe("C:\\MB-TEST", "c:\\"), false);
    assert.equal(isBackupTargetSafe("c:\\mb-test", "C:\\BACKUPS"), true);
  });
});

describe("tricksPreview", () => {
  it("shows the newest saved entries first", () => {
    const content = [
      "# Tricks",
      "",
      "Workarounds that worked, one per line, newest first.",
      "",
      "### 2026-10-27 10:00 · Session aa11",
      "",
      "- First workaround.",
      "",
      "### 2026-10-28 09:00 · Session bb22",
      "",
      "- Second workaround.",
      "",
    ].join("\n");
    const preview = tricksPreview(content);
    assert.ok(preview.indexOf("Second workaround.") < preview.indexOf("First workaround."));
    assert.ok(preview.includes("### 2026-10-28 09:00 · Session bb22"));
  });

  it("falls back to the first lines without dated entries", () => {
    assert.equal(tricksPreview("# Tricks\n\n- Newest.\n- Oldest.\n"), "- Newest.\n- Oldest.");
    assert.equal(tricksPreview("# Tricks\n"), "");
  });
});

describe("front door rule 9", () => {
  it("tells Muse to back up before changing", () => {
    assert.ok(
      FRONT_DOOR_SECTION.includes(
        "9. Before changing an existing file, copy it to .backups/<date>/<same path> first, and say where the copy is in one line.",
      ),
    );
  });
});

describe("ensureGitignoreEntry", () => {
  it("creates the file when missing", async () => {
    const fs = fakeFs();
    assert.equal(await ensureGitignoreEntry("root", ".backups/", fs), true);
    assert.equal(fs.files.get(join("root", ".gitignore")), ".backups/\n");
  });

  it("appends without touching the rest", async () => {
    const fs = fakeFs();
    const target = join("root", ".gitignore");
    fs.files.set(target, "node_modules/\n");
    assert.equal(await ensureGitignoreEntry("root", ".backups/", fs), true);
    assert.equal(fs.files.get(target), "node_modules/\n.backups/\n");
  });

  it("leaves the file alone when the entry is there", async () => {
    const fs = fakeFs();
    const target = join("root", ".gitignore");
    for (const content of ["node_modules/\n.backups/\n", ".backups", "# nothing\n.backups/\n"]) {
      fs.files.set(target, content);
      assert.equal(await ensureGitignoreEntry("root", ".backups/", fs), false);
      assert.equal(fs.files.get(target), content);
    }
  });

  it("repairs a missing trailing newline", async () => {
    const fs = fakeFs();
    const target = join("root", ".gitignore");
    fs.files.set(target, "node_modules/");
    assert.equal(await ensureGitignoreEntry("root", ".backups/", fs), true);
    assert.equal(fs.files.get(target), "node_modules/\n.backups/\n");
  });
});

describe("live labels", () => {
  it("a fresh heartbeat on the stored id means taken", () => {
    const now = Date.now();
    assert.equal(isLabelTaken("ab12", { ab12: now - 1000 }, now), true);
    assert.equal(isLabelTaken("ab12", { ab12: now - LIVE_LABEL_TTL_MS }, now), false);
    assert.equal(isLabelTaken("ab12", { cd34: now - 1000 }, now), false);
    assert.equal(isLabelTaken("ab12", {}, now), false);
  });

  it("forgets anything that is not id -> timestamp", () => {
    assert.deepEqual(cleanLiveLabels({ ab12: 1000, "": 1000, cd34: "soon", ef56: Number.NaN }), {
      ab12: 1000,
    });
    assert.deepEqual(cleanLiveLabels([["ab12", 1000]]), {});
    assert.deepEqual(cleanLiveLabels(undefined), {});
  });
});
