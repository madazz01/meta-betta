import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanEffortLevel,
  cleanGoalInfo,
  commandErrorText,
  findSlashCommand,
  parsePluginSpec,
  parseSlashCommand,
  SLASH_COMMANDS,
  unknownCommandText,
  type CardHandlers,
  type CardSpec,
  type EffortLevel,
  type GoalInfo,
  type ModelRow,
  type PluginRow,
  type ResumeSession,
  type SkillRow,
  type SlashContext,
  type TaskRow,
  type UsageInfo,
} from "../commands/slash.js";

/** Recording fake: script returns, throw from one method with fail(). */
class FakeCtx implements SlashContext {
  cards: { id: string; card: CardSpec; handlers?: CardHandlers }[] = [];
  notices: { kind: string; text: string }[] = [];
  closed: string[] = [];
  calls: string[] = [];
  sessions: ResumeSession[] = [];
  usage: UsageInfo = { today: { totalTokens: 0, usd: 0 } };
  models: ModelRow[] = [];
  compactResult: "compacted" | "noop" = "compacted";
  recapResult: { text: string; title?: string } = { text: "We fixed the login page.", title: "Fixes" };
  goalState: GoalInfo | null = null;
  sideAnswer = "A side answer.";
  tasks: TaskRow[] = [];
  skills: SkillRow[] = [];
  plugins: PluginRow[] = [];
  effort: EffortLevel = "normal";
  exportPath: string | undefined = "chat.md";
  failures = new Map<string, unknown>();

  private maybeFail(method: string): void {
    if (this.failures.has(method)) {
      throw this.failures.get(method);
    }
  }

  showCard(card: CardSpec, handlers?: CardHandlers): string {
    const id = `card-${this.cards.length + 1}`;
    this.cards.push({ id, card, handlers });
    return id;
  }

  updateCard(id: string, card: CardSpec): void {
    this.calls.push(`update:${id}`);
    const found = this.cards.find((entry) => entry.id === id);
    if (found) {
      found.card = card;
    }
  }

  closeCard(id: string): void {
    this.closed.push(id);
  }

  notice(kind: "info" | "error", text: string): void {
    this.notices.push({ kind, text });
  }

  async newChat(): Promise<void> {
    this.calls.push("newChat");
  }

  async saveMyDay(): Promise<void> {
    this.calls.push("saveMyDay");
  }

  stop(): void {
    this.calls.push("stop");
  }

  clearView(): void {
    this.calls.push("clearView");
  }

  async focusBrain(): Promise<void> {
    this.calls.push("focusBrain");
  }

  async exportHistory(): Promise<string | undefined> {
    this.calls.push("exportHistory");
    return this.exportPath;
  }

  async listSessions(): Promise<ResumeSession[]> {
    this.maybeFail("listSessions");
    return this.sessions;
  }

  async switchToSession(id: string): Promise<void> {
    this.maybeFail("switchToSession");
    this.calls.push(`switch:${id}`);
  }

  async readUsage(): Promise<UsageInfo> {
    this.maybeFail("readUsage");
    return this.usage;
  }

  async listModels(): Promise<ModelRow[]> {
    this.maybeFail("listModels");
    return this.models;
  }

  async setModel(modelId: string): Promise<void> {
    this.maybeFail("setModel");
    this.calls.push(`setModel:${modelId}`);
  }

  async compact(): Promise<"compacted" | "noop"> {
    this.maybeFail("compact");
    return this.compactResult;
  }

  async recap(): Promise<{ text: string; title?: string }> {
    this.maybeFail("recap");
    return this.recapResult;
  }

  async goal(op: "set" | "edit" | "pause" | "resume" | "clear", text?: string): Promise<void> {
    this.maybeFail("goal");
    this.calls.push(`goal:${op}${text === undefined ? "" : `:${text}`}`);
  }

  currentGoal(): GoalInfo | null {
    return this.goalState;
  }

  async sideAsk(question: string, onProgress?: (line: string) => void): Promise<string> {
    this.maybeFail("sideAsk");
    this.calls.push(`sideAsk:${question}`);
    onProgress?.("Chat opened");
    return this.sideAnswer;
  }

  async fork(): Promise<void> {
    this.maybeFail("fork");
    this.calls.push("fork");
  }

  async listTasks(): Promise<TaskRow[]> {
    this.maybeFail("listTasks");
    return this.tasks;
  }

  async stopTask(taskId: string): Promise<void> {
    this.maybeFail("stopTask");
    this.calls.push(`stopTask:${taskId}`);
  }

  async stopAllTasks(): Promise<void> {
    this.maybeFail("stopAllTasks");
    this.calls.push("stopAllTasks");
  }

  async listSkills(): Promise<SkillRow[]> {
    this.maybeFail("listSkills");
    return this.skills;
  }

  async setSkill(selector: string, on: boolean): Promise<void> {
    this.maybeFail("setSkill");
    this.calls.push(`setSkill:${selector}:${on ? "on" : "off"}`);
  }

  async listPlugins(): Promise<PluginRow[]> {
    this.maybeFail("listPlugins");
    return this.plugins;
  }

  async installPlugin(spec: string): Promise<string> {
    this.maybeFail("installPlugin");
    this.calls.push(`installPlugin:${spec}`);
    return `Installed ${spec}.`;
  }

  async setEffort(level: EffortLevel): Promise<void> {
    this.maybeFail("setEffort");
    this.calls.push(`setEffort:${level}`);
  }

  currentEffort(): EffortLevel {
    return this.effort;
  }
}

async function run(name: string, ctx: FakeCtx, args = ""): Promise<void> {
  const def = findSlashCommand(name);
  assert.ok(def, `/${name} is registered`);
  await def.run(ctx, args);
}

describe("parseSlashCommand", () => {
  it("splits command and args", () => {
    assert.deepEqual(parseSlashCommand("/usage"), { name: "usage", args: "" });
    assert.deepEqual(parseSlashCommand("/model muse-spark-1.3"), { name: "model", args: "muse-spark-1.3" });
    assert.deepEqual(parseSlashCommand("/goal   build the thing  "), { name: "goal", args: "build the thing" });
  });

  it("is case-insensitive on the name only", () => {
    assert.deepEqual(parseSlashCommand("/Usage"), { name: "usage", args: "" });
    assert.deepEqual(parseSlashCommand("/GOAL Build It"), { name: "goal", args: "Build It" });
  });

  it("treats a bare slash as help, other text as chat", () => {
    assert.deepEqual(parseSlashCommand("/"), { name: "help", args: "" });
    assert.deepEqual(parseSlashCommand("/   "), { name: "help", args: "" });
    assert.deepEqual(parseSlashCommand("/usage!"), { name: "usage", args: "" });
    assert.equal(parseSlashCommand("hello"), undefined);
    assert.equal(parseSlashCommand("use /usage later"), undefined);
    assert.equal(parseSlashCommand("/tmp/foo is the path"), undefined);
    assert.equal(parseSlashCommand(""), undefined);
  });
});

describe("slash registry", () => {
  it("lists every command with a one-line description", () => {
    const names = SLASH_COMMANDS.map((def) => def.name);
    assert.deepEqual(names, [
      "help",
      "new",
      "resume",
      "save",
      "usage",
      "model",
      "compact",
      "recap",
      "goal",
      "side",
      "fork",
      "tasks",
      "skills",
      "plugins",
      "effort",
      "export",
      "brain",
      "stop",
      "clear",
    ]);
    for (const def of SLASH_COMMANDS) {
      assert.ok(def.description.length > 0 && !def.description.includes("\n"), `/${def.name} described`);
    }
  });

  it("finds commands, or nothing", () => {
    assert.equal(findSlashCommand("usage")?.name, "usage");
    assert.equal(findSlashCommand("nope"), undefined);
  });

  it("words unknown commands plainly", () => {
    assert.equal(unknownCommandText("xyz"), "I don't know /xyz, type /help");
  });

  it("names version gaps instead of failing", () => {
    assert.equal(commandErrorText({ code: -32601 }), "Not available in this version of Muse Code yet");
    assert.equal(commandErrorText(new Error("boom")), "boom");
  });

  it("cleans stored goal and effort state", () => {
    assert.deepEqual(
      cleanGoalInfo({ objective: "Ship it", percentComplete: 45, status: "active", currentWork: "Tests" }),
      { objective: "Ship it", percentComplete: 45, status: "active", currentWork: "Tests" },
    );
    assert.equal(cleanGoalInfo(null), null);
    assert.equal(cleanGoalInfo({ objective: "Ship it" }), null);
    assert.equal(cleanGoalInfo("nope"), null);
    assert.equal(cleanEffortLevel("deep"), "deep");
    assert.equal(cleanEffortLevel("turbo"), "normal");
    assert.equal(cleanEffortLevel(undefined), "normal");
  });
});

describe("parsePluginSpec", () => {
  it("reads store:name and folder paths", () => {
    assert.deepEqual(parsePluginSpec("acme:deploy"), {
      kind: "marketplace",
      marketplace: "acme",
      name: "deploy",
    });
    assert.deepEqual(parsePluginSpec("/tmp/my-plugin"), { kind: "path", path: "/tmp/my-plugin" });
    assert.deepEqual(parsePluginSpec("C:\\plugins\\mine"), { kind: "path", path: "C:\\plugins\\mine" });
    assert.deepEqual(parsePluginSpec("./rel"), { kind: "path", path: "./rel" });
  });

  it("rejects bare names", () => {
    assert.equal(parsePluginSpec("deploy"), undefined);
    assert.equal(parsePluginSpec(""), undefined);
    assert.equal(parsePluginSpec("acme:"), undefined);
  });
});

describe("slash runs", () => {
  it("/help lists every command", async () => {
    const ctx = new FakeCtx();
    await run("help", ctx);
    assert.equal(ctx.cards.length, 1);
    for (const def of SLASH_COMMANDS) {
      assert.ok(ctx.cards[0]?.card.body.includes(`/${def.name}`), `/${def.name} listed`);
    }
  });

  it("trivial commands call through", async () => {
    const ctx = new FakeCtx();
    await run("new", ctx);
    await run("save", ctx);
    await run("stop", ctx);
    await run("clear", ctx);
    await run("brain", ctx);
    assert.deepEqual(ctx.calls, ["newChat", "saveMyDay", "stop", "clearView", "focusBrain"]);
  });

  it("/export names the file, or stays silent on cancel", async () => {
    const ctx = new FakeCtx();
    await run("export", ctx);
    assert.deepEqual(ctx.notices, [{ kind: "info", text: "Saved the chat to chat.md." }]);
    ctx.exportPath = undefined;
    await run("export", ctx);
    assert.equal(ctx.notices.length, 1);
  });

  it("/usage shows session, today and the dashboard link", async () => {
    const ctx = new FakeCtx();
    ctx.usage = {
      session: { promptTokens: 12400, outputTokens: 3100, totalTokens: 15500, usd: 0.03 },
      today: { totalTokens: 45200, usd: 0.1 },
    };
    await run("usage", ctx);
    const body = ctx.cards[0]?.card.body ?? "";
    assert.ok(body.includes("12.4k"));
    assert.ok(body.includes("~$0.03"));
    assert.ok(body.includes("estimate"));
    assert.ok(body.includes("45.2k"));
    assert.ok(body.includes("https://dev.meta.ai/platform"));
  });

  it("/usage copes with no data and errors", async () => {
    const ctx = new FakeCtx();
    await run("usage", ctx);
    assert.ok((ctx.cards[0]?.card.body ?? "").includes("No usage yet"));
    ctx.failures.set("readUsage", new Error("boom"));
    await run("usage", ctx);
    assert.deepEqual(ctx.notices, [{ kind: "error", text: "Couldn't read usage: boom." }]);
  });

  it("/usage shows the account allowance when reported", async () => {
    const ctx = new FakeCtx();
    ctx.usage = {
      today: { totalTokens: 0, usd: 0 },
      weekly: { usedPercent: 45, resetsAtMs: new Date(2026, 10, 3, 9, 0).getTime() },
      window: { usedPercent: 12, resetsAtMs: new Date(2026, 9, 30, 14, 15).getTime() },
    };
    await run("usage", ctx);
    const body = ctx.cards[0]?.card.body ?? "";
    assert.ok(body.includes("This week: 45% used"));
    assert.ok(body.includes("Right now: 12% used"));
    assert.ok(body.includes("2:15pm"));
  });

  it("/model lists with the current marked, and switches", async () => {
    const ctx = new FakeCtx();
    ctx.models = [
      { modelId: "muse-spark-1.3", label: "Muse Spark 1.3", active: true },
      { modelId: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor", active: false },
    ];
    await run("model", ctx);
    const card = ctx.cards[0]?.card;
    assert.ok((card?.body ?? "").includes("Muse Spark 1.3"));
    assert.equal(card?.buttons?.length, 2);
    await ctx.cards[0]?.handlers?.onButton?.("muse-spark-1.3-contributor");
    assert.deepEqual(ctx.calls, ["setModel:muse-spark-1.3-contributor", "update:card-1"]);
  });

  it("/model warns on the contributor model only", async () => {
    const ctx = new FakeCtx();
    ctx.models = [{ modelId: "muse-spark-1.3-contributor", label: "Contributor", active: true }];
    await run("model", ctx);
    assert.ok((ctx.cards[0]?.card.body ?? "").includes("Don't paste anything private"));
    ctx.models = [{ modelId: "muse-spark-1.3", label: "Spark", active: true }];
    await run("model", ctx);
    assert.ok(!(ctx.cards[1]?.card.body ?? "").includes("Don't paste anything private"));
  });

  it("/model takes a name as args, or says so", async () => {
    const ctx = new FakeCtx();
    ctx.models = [{ modelId: "muse-spark-1.3", label: "Spark", active: false }];
    await run("model", ctx, "MUSE-SPARK-1.3");
    assert.deepEqual(ctx.calls, ["setModel:muse-spark-1.3"]);
    await run("model", ctx, "nope");
    assert.ok((ctx.notices[1]?.text ?? "").includes("can't see nope"));
  });

  it("/compact words noop and tidied", async () => {
    const ctx = new FakeCtx();
    await run("compact", ctx);
    assert.deepEqual(ctx.notices, [
      { kind: "info", text: "Tidied up the chat history, kept the important bits." },
    ]);
    ctx.compactResult = "noop";
    await run("compact", ctx);
    assert.equal(ctx.notices[1]?.text, "Nothing to tidy yet.");
  });

  it("/recap cards the summary, however it settles", async () => {
    const ctx = new FakeCtx();
    await run("recap", ctx);
    assert.ok((ctx.cards[0]?.card.body ?? "").includes("We fixed the login page."));
    ctx.recapResult = { text: "x", title: "t".repeat(100) };
    await run("recap", ctx);
    assert.equal((ctx.cards[1]?.card.title ?? "").length, "Recap: ".length + 80);
    ctx.failures.set("recap", new Error("boom"));
    await run("recap", ctx);
    assert.ok((ctx.cards[2]?.card.body ?? "").includes("Couldn't write a recap: boom."));
  });

  it("/goal sets, shows and drives the verbs", async () => {
    const ctx = new FakeCtx();
    await run("goal", ctx, "build the shopping list page");
    assert.deepEqual(ctx.calls, ["goal:set:build the shopping list page"]);
    await run("goal", ctx, "pause");
    await run("goal", ctx, "resume");
    await run("goal", ctx, "clear");
    await run("goal", ctx, "edit build it better");
    assert.deepEqual(ctx.calls.slice(1), [
      "goal:pause",
      "goal:resume",
      "goal:clear",
      "goal:edit:build it better",
    ]);
    // A longer sentence starting with a verb is still a goal, not the verb.
    await run("goal", ctx, "pause now and rest");
    assert.ok(ctx.calls.includes("goal:set:pause now and rest"));
  });

  it("/goal shows the pin, or how to set one", async () => {
    const ctx = new FakeCtx();
    await run("goal", ctx);
    assert.ok((ctx.notices[0]?.text ?? "").includes("No goal pinned"));
    ctx.goalState = { objective: "Ship it", percentComplete: 45, status: "active" };
    await run("goal", ctx);
    assert.ok((ctx.cards[0]?.card.body ?? "").includes("Ship it"));
    await run("goal", ctx, "edit");
    assert.ok((ctx.notices[1]?.text ?? "").includes("/goal edit"));
  });

  it("/side asks now or opens the box", async () => {
    const ctx = new FakeCtx();
    await run("side", ctx, "What is a closure?");
    assert.ok((ctx.cards[0]?.card.body ?? "").includes("A side answer."));
    await run("side", ctx);
    assert.ok(ctx.cards[1]?.card.input, "empty card has an input");
    await ctx.cards[1]?.handlers?.onInput?.("Asked late?");
    assert.deepEqual(
      ctx.calls.filter((call) => call.startsWith("sideAsk")),
      ["sideAsk:What is a closure?", "sideAsk:Asked late?"],
    );
  });

  it("/resume lists, switches, or says there's nothing", async () => {
    const ctx = new FakeCtx();
    await run("resume", ctx);
    assert.ok((ctx.notices[0]?.text ?? "").includes("No earlier chats"));
    ctx.sessions = [{ id: "s1", name: "Login fixes", updatedAt: "", turnCount: 12 }];
    await run("resume", ctx);
    assert.equal(ctx.cards[0]?.card.buttons?.length, 1);
    await ctx.cards[0]?.handlers?.onButton?.("s1");
    assert.deepEqual(ctx.calls, ["switch:s1"]);
  });

  it("/fork forks, /tasks lists and stops", async () => {
    const ctx = new FakeCtx();
    await run("fork", ctx);
    assert.ok((ctx.notices[0]?.text ?? "").includes("Forked"));
    await run("tasks", ctx);
    assert.ok((ctx.notices[1]?.text ?? "").includes("Nothing running"));
    ctx.tasks = [{ taskId: "t1", label: "npm test", detail: "background" }];
    await run("tasks", ctx);
    assert.ok((ctx.cards[0]?.card.body ?? "").includes("npm test"));
    await ctx.cards[0]?.handlers?.onButton?.("task:t1");
    await ctx.cards[0]?.handlers?.onButton?.("all");
    assert.deepEqual(ctx.calls, ["fork", "stopTask:t1", "update:card-1", "stopAllTasks", "update:card-1"]);
  });

  it("/skills toggles and /plugins installs", async () => {
    const ctx = new FakeCtx();
    ctx.skills = [{ selector: "fix-bug", name: "Fix bug", description: "Fixes a bug." }];
    await run("skills", ctx);
    await ctx.cards[0]?.handlers?.onButton?.("off:fix-bug");
    assert.ok(ctx.calls.includes("setSkill:fix-bug:off"));
    ctx.plugins = [{ id: "acme", version: "1.2", enabled: true }];
    await run("plugins", ctx);
    await ctx.cards[1]?.handlers?.onInput?.("acme:deploy");
    assert.ok(ctx.calls.includes("installPlugin:acme:deploy"));
    await ctx.cards[1]?.handlers?.onInput?.("bare");
    assert.ok((ctx.notices.at(-1)?.text ?? "").includes("store:name"));
  });

  it("/effort sets, shows and corrects", async () => {
    const ctx = new FakeCtx();
    await run("effort", ctx);
    assert.equal(ctx.cards[0]?.card.buttons?.length, 3);
    await run("effort", ctx, "deep");
    assert.deepEqual(ctx.calls, ["setEffort:deep"]);
    assert.ok((ctx.notices[0]?.text ?? "").includes("Deep"));
    await run("effort", ctx, "turbo");
    assert.ok((ctx.notices[1]?.text ?? "").includes("quick, normal or deep"));
  });

  it("failures surface one plain line", async () => {
    const ctx = new FakeCtx();
    ctx.failures.set("listSessions", { code: -32601 });
    await run("resume", ctx);
    assert.deepEqual(ctx.notices, [
      { kind: "error", text: "Couldn't list chats: Not available in this version of Muse Code yet." },
    ]);
  });
});
