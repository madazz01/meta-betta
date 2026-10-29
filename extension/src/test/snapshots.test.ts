// Shadow snapshots, against real git in temp folders. Skipped where git
// isn't installed (except the no-git test itself, which needs it missing).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  formatUndoTime,
  LARGE_FILE_BYTES,
  NoGitError,
  ShadowSnapshots,
} from "../safety/snapshots.js";

const execFileAsync = promisify(execFile);

let gitFound: boolean | undefined;
function gitAvailable(): boolean {
  gitFound ??= (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  return gitFound;
}

const needsGit = { skip: !gitAvailable() };

async function sandbox(): Promise<{ work: string; store: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "meta-betta-shadow-"));
  const work = join(root, "work");
  const store = join(root, "storage");
  await mkdir(work, { recursive: true });
  return { work, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function shadow(work: string, store: string, options?: { keepSnapshots?: number; pruneAt?: number }): ShadowSnapshots {
  return new ShadowSnapshots(work, join(store, "shadow.git"), options);
}

async function userGit(work: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: work });
  return stdout;
}

describe("shadow snapshots", needsGit, () => {
  it("snapshots a turn and undoes it exactly", async () => {
    const { work, store, cleanup } = await sandbox();
    try {
      const shots = shadow(work, store);
      await mkdir(join(work, "sub"), { recursive: true });
      await writeFile(join(work, "a.txt"), "one", "utf8");
      await writeFile(join(work, "sub", "b.txt"), "two", "utf8");
      const before = await shots.snapshot("before turn");
      await writeFile(join(work, "a.txt"), "CHANGED", "utf8");
      await writeFile(join(work, "c.txt"), "new", "utf8");
      await rm(join(work, "sub", "b.txt"));
      const after = await shots.snapshot("after turn");
      const diff = await shots.diffFiles(before.sha, after.sha, before.excluded);
      assert.deepEqual(
        diff.map((file) => `${file.change} ${file.path}`).sort(),
        ["added c.txt", "deleted sub/b.txt", "modified a.txt"],
      );
      assert.deepEqual(await shots.changedSince(diff, after.sha), []);
      const result = await shots.restore(diff, before.sha);
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.restored.sort(), ["a.txt", "c.txt", "sub/b.txt"].sort());
      assert.equal(await readFile(join(work, "a.txt"), "utf8"), "one");
      assert.equal(await readFile(join(work, "sub", "b.txt"), "utf8"), "two");
      await assert.rejects(readFile(join(work, "c.txt"), "utf8"));
    } finally {
      await cleanup();
    }
  });

  it("leaves ignored, brain and big files alone", async () => {
    const { work, store, cleanup } = await sandbox();
    try {
      const shots = shadow(work, store);
      await writeFile(join(work, ".gitignore"), "ignored.txt\n", "utf8");
      await mkdir(join(work, "node_modules", "pkg"), { recursive: true });
      await mkdir(join(work, ".git", "objects"), { recursive: true });
      await mkdir(join(work, ".backups", "2026-10-29"), { recursive: true });
      await mkdir(join(work, "brain"), { recursive: true });
      for (const file of [
        "ignored.txt",
        "node_modules/pkg/x.js",
        ".git/objects/y",
        ".backups/2026-10-29/a.txt",
        "brain/project.md",
      ]) {
        await writeFile(join(work, file), "v1", "utf8");
      }
      await writeFile(join(work, "big.bin"), Buffer.alloc(LARGE_FILE_BYTES + 1024));
      const before = await shots.snapshot("before turn");
      for (const file of [
        "ignored.txt",
        "node_modules/pkg/x.js",
        ".git/objects/y",
        ".backups/2026-10-29/a.txt",
        "brain/project.md",
        "big.bin",
      ]) {
        await writeFile(join(work, file), "v2", "utf8");
      }
      const after = await shots.snapshot("after turn");
      assert.deepEqual(await shots.diffFiles(before.sha, after.sha, before.excluded), []);
      assert.ok(before.excluded.includes("big.bin"));
    } finally {
      await cleanup();
    }
  });

  it("a file that shrank below the limit is not reported as added", async () => {
    const { work, store, cleanup } = await sandbox();
    try {
      const shots = shadow(work, store);
      await writeFile(join(work, "shrank.bin"), Buffer.alloc(LARGE_FILE_BYTES + 1024));
      const before = await shots.snapshot("before turn");
      await writeFile(join(work, "shrank.bin"), "small now", "utf8");
      const after = await shots.snapshot("after turn");
      // Without the guard this looks "added" — and Undo would delete it.
      assert.deepEqual(await shots.diffFiles(before.sha, after.sha, before.excluded), []);
    } finally {
      await cleanup();
    }
  });

  it("changedSince spots later edits, skips hand-deleted new files", async () => {
    const { work, store, cleanup } = await sandbox();
    try {
      const shots = shadow(work, store);
      await writeFile(join(work, "a.txt"), "one", "utf8");
      await writeFile(join(work, "d.txt"), "doomed", "utf8");
      const before = await shots.snapshot("before turn");
      await writeFile(join(work, "a.txt"), "two", "utf8");
      await writeFile(join(work, "c.txt"), "new", "utf8");
      await rm(join(work, "d.txt"));
      const after = await shots.snapshot("after turn");
      const diff = await shots.diffFiles(before.sha, after.sha, before.excluded);
      await writeFile(join(work, "a.txt"), "three", "utf8");
      await rm(join(work, "c.txt"));
      await writeFile(join(work, "d.txt"), "recreated", "utf8");
      assert.deepEqual((await shots.changedSince(diff, after.sha)).sort(), ["a.txt", "d.txt"]);
    } finally {
      await cleanup();
    }
  });

  it("never touches the user's own git history, index or files", async () => {
    const { work, store, cleanup } = await sandbox();
    try {
      await userGit(work, ["init"]);
      await userGit(work, ["config", "user.name", "Test"]);
      await userGit(work, ["config", "user.email", "test@test"]);
      await writeFile(join(work, "a.txt"), "one", "utf8");
      await userGit(work, ["add", "a.txt"]);
      await userGit(work, ["commit", "-m", "first"]);
      await writeFile(join(work, "a.txt"), "staged change", "utf8");
      await userGit(work, ["add", "a.txt"]);
      const logBefore = await userGit(work, ["log", "--oneline"]);
      const statusBefore = await userGit(work, ["status", "--porcelain"]);
      const shots = shadow(work, store);
      const before = await shots.snapshot("before turn");
      await writeFile(join(work, "a.txt"), "turn change", "utf8");
      await writeFile(join(work, "new.txt"), "new", "utf8");
      const after = await shots.snapshot("after turn");
      const diff = await shots.diffFiles(before.sha, after.sha, before.excluded);
      await shots.restore(diff, before.sha);
      assert.equal(await userGit(work, ["log", "--oneline"]), logBefore);
      assert.equal(await userGit(work, ["status", "--porcelain"]), statusBefore);
    } finally {
      await cleanup();
    }
  });

  it("never snapshots the shadow repo itself, even nested inside", async () => {
    const { work, cleanup } = await sandbox();
    try {
      const shots = new ShadowSnapshots(work, join(work, "storage", "shadow.git"));
      await writeFile(join(work, "a.txt"), "one", "utf8");
      const before = await shots.snapshot("before turn");
      await writeFile(join(work, "a.txt"), "two", "utf8");
      const after = await shots.snapshot("after turn");
      assert.deepEqual(await shots.diffFiles(before.sha, after.sha, before.excluded), [
        { path: "a.txt", change: "modified" },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("prunes old snapshots past the window", async () => {
    const { work, store, cleanup } = await sandbox();
    try {
      const shots = shadow(work, store, { keepSnapshots: 5, pruneAt: 7 });
      await writeFile(join(work, "a.txt"), "v0", "utf8");
      const shas: string[] = [];
      for (let turn = 0; turn < 9; turn += 1) {
        await writeFile(join(work, "a.txt"), `v${turn}`, "utf8");
        shas.push((await shots.snapshot(`turn ${turn}`)).sha);
      }
      const { stdout } = await execFileAsync(
        "git",
        [`--git-dir=${join(store, "shadow.git")}`, "for-each-ref", "--format=%(refname)", "refs/shadows"],
        { cwd: work },
      );
      const refs = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      assert.ok(refs.length <= 7);
      assert.equal(await shots.has(shas[0] ?? ""), false);
      assert.equal(await shots.has(shas[shas.length - 1] ?? ""), true);
    } finally {
      await cleanup();
    }
  });

  it("waits out a briefly locked index", async () => {
    const { work, store, cleanup } = await sandbox();
    try {
      const shots = shadow(work, store);
      await writeFile(join(work, "a.txt"), "one", "utf8");
      await shots.snapshot("before turn");
      const lock = join(store, "shadow.git", "index.lock");
      await writeFile(lock, "held", "utf8");
      setTimeout(() => void rm(lock, { force: true }), 100);
      await writeFile(join(work, "a.txt"), "two", "utf8");
      const after = await shots.snapshot("after turn");
      assert.equal(await shots.has(after.sha), true);
    } finally {
      await cleanup();
    }
  });

  it("gives up on a stuck lock", async () => {
    const { work, store, cleanup } = await sandbox();
    try {
      const shots = shadow(work, store);
      await writeFile(join(work, "a.txt"), "one", "utf8");
      await shots.snapshot("before turn");
      await writeFile(join(store, "shadow.git", "index.lock"), "stuck", "utf8");
      await assert.rejects(shots.snapshot("after turn"));
    } finally {
      await cleanup();
    }
  });

  it("has() tells kept snapshots from unknown ones", async () => {
    const { work, store, cleanup } = await sandbox();
    try {
      const shots = shadow(work, store);
      await writeFile(join(work, "a.txt"), "one", "utf8");
      const before = await shots.snapshot("before turn");
      assert.equal(await shots.has(before.sha), true);
      assert.equal(await shots.has("0".repeat(40)), false);
    } finally {
      await cleanup();
    }
  });
});

describe("no git", () => {
  it("snapshot fails with NoGitError when git is missing", async () => {
    const { work, store, cleanup } = await sandbox();
    try {
      const shots = new ShadowSnapshots(work, join(store, "shadow.git"), {
        gitBin: "/nonexistent-git-binary",
      });
      await assert.rejects(shots.snapshot("before turn"), NoGitError);
    } finally {
      await cleanup();
    }
  });
});

describe("formatUndoTime", () => {
  it("words the time like 10:40", () => {
    assert.equal(formatUndoTime(new Date(2026, 9, 29, 10, 40)), "10:40");
    assert.equal(formatUndoTime(new Date(2026, 9, 29, 9, 5)), "9:05");
  });
});
