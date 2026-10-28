import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  appendEntry,
  brainCardInputs,
  buildBrainCards,
  cleanTopic,
  createSessionId,
  ensureBrain,
  ensureFrontDoor,
  entryHeading,
  formatSessionLabel,
  formatUpdated,
  FRONT_DOOR_SECTION,
  startHereSection,
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
    assert.equal(card?.excerpt, "# Tricks\n\nRestart it.\n\nTwice.");
  });

  it("marks missing files", () => {
    const [card] = buildBrainCards([{ file: "me.md", title: "About you", mtimeMs: undefined, content: undefined }]);
    assert.equal(card?.updated, "Nothing here yet");
    assert.equal(card?.excerpt, "Nothing here yet.");
  });
});

describe("startHereSection", () => {
  it("falls back to the first lines without the heading", () => {
    assert.equal(startHereSection("# Nope\n\nJust text.\n"), "# Nope\n\nJust text.");
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
