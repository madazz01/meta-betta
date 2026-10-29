import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  appendEntry,
  brainCardInputs,
  buildBackgroundBlock,
  buildBrainCards,
  catchUpGreeting,
  cleanSessionLabel,
  cleanTopic,
  continuedTopic,
  createSessionId,
  ensureBrain,
  ensureFrontDoor,
  entryHeading,
  formatSessionLabel,
  formatUpdated,
  FRONT_DOOR_SECTION,
  greetingName,
  needsCatchUp,
  startHereSection,
  stripBackgroundPrefix,
  todayLogFile,
  topicFromFirstMessage,
  type BrainFs,
} from "../brain/brain.js";

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
