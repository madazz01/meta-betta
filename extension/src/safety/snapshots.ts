// Private shadow git repo: a snapshot before and after every turn, so each
// reply that changed files gets an Undo button. The repo lives in the
// extension's workspace storage and is driven with --git-dir/--work-tree, so
// it never touches the user's own .git, branches or index — and it works in
// folders that aren't git repos at all.
//
// What a snapshot skips: the user's .gitignore, node_modules/, .git/,
// .backups/, brain/ (the brain only grows and must never be "undone") and
// any file over 5 MB.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Thrown when git isn't installed. The caller shows one plain line, once. */
export class NoGitError extends Error {
  public constructor() {
    super("git not found");
    this.name = "NoGitError";
  }
}

export interface ChangedFile {
  /** Work-tree relative, forward slashes. */
  path: string;
  change: "modified" | "added" | "deleted";
}

export interface RestoreResult {
  restored: string[];
  failed: string[];
}

export interface Snapshot {
  sha: string;
  /** Work-tree relative paths skipped for size; guards diffFiles (see below). */
  excluded: string[];
}

/** Files bigger than this are never snapshotted. */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".backups", "brain"]);

const SHADOW_EXCLUDE = `# Meta Betta shadow snapshots: never snapshot these.
.git/
node_modules/
.backups/
brain/
`;

export interface ShadowOptions {
  /** Git binary; a seam so tests can simulate git missing. */
  gitBin?: string;
  /** Snapshots kept per workspace (older ones are pruned). */
  keepSnapshots?: number;
  /** Prune when the history passes this many snapshots. */
  pruneAt?: number;
}

export class ShadowSnapshots {
  private readonly gitBin: string;
  private readonly keepSnapshots: number;
  private readonly pruneAt: number;
  private ready: Promise<void> | undefined;
  /** Serialises every command: two snapshots at once would fight over the index. */
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly workTree: string,
    private readonly gitDir: string,
    options: ShadowOptions = {},
  ) {
    this.gitBin = options.gitBin ?? "git";
    this.keepSnapshots = options.keepSnapshots ?? 200;
    this.pruneAt = options.pruneAt ?? 220;
  }

  /**
   * Snapshot the workspace now. Each snapshot is a standalone root commit
   * under refs/shadows/ (never a chained branch: rewinding a branch rewinds
   * history instead of trimming it, and rebuilding 200 commits is silly).
   */
  public snapshot(message: string): Promise<Snapshot> {
    return this.enqueue(async () => {
      await this.ensureReady();
      const excluded = await bigFileExcludes(this.workTree);
      // The repo itself must never be snapshotted (normally it lives outside
      // the workspace, but never say never: self-snapshots grow without bound).
      const self = selfExclude(this.workTree, this.gitDir);
      const args = ["add", "-A", "--", ".", ...excluded.map((path) => `:(exclude,literal)${path}`)];
      if (self) {
        args.push(self);
      }
      await this.git(args);
      const tree = (await this.git(["write-tree"])).trim();
      const sha = (
        await this.git([
          "-c",
          "user.name=Meta Betta",
          "-c",
          "user.email=meta-betta@local",
          "commit-tree",
          tree,
          "-m",
          message,
        ])
      ).trim();
      const stamp = Date.now().toString().padStart(15, "0");
      await this.git(["update-ref", `refs/shadows/${stamp}-${randomBytes(3).toString("hex")}`, sha]);
      await this.prune();
      return { sha, excluded };
    });
  }

  /**
   * Files changed between two snapshots. `excludedBefore` (from the before
   * snapshot) guards a trap: a file that was too big to snapshot before, but
   * shrank since, looks "added" — it isn't the turn's doing, so it's dropped
   * rather than risk Undo deleting a file the user already had.
   */
  public diffFiles(before: string, after: string, excludedBefore: string[] = []): Promise<ChangedFile[]> {
    return this.enqueue(async () => {
      const out = await this.git(["diff", "--name-status", "--no-renames", "-z", before, after]);
      const parts = out.split("\0").filter((part) => part !== "");
      const files: ChangedFile[] = [];
      for (let index = 0; index + 1 < parts.length; index += 2) {
        const status = parts[index] ?? "";
        const path = parts[index + 1] ?? "";
        const change = status === "A" ? "added" : status === "D" ? "deleted" : "modified";
        if (change === "added" && excludedBefore.includes(path)) {
          continue;
        }
        files.push({ path, change });
      }
      return files;
    });
  }

  /** True when the snapshot is still kept (old ones are pruned away). */
  public has(sha: string): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        const refs = await this.git(["for-each-ref", "--format=%(objectname)", "refs/shadows"]);
        return refs
          .split("\n")
          .map((line) => line.trim())
          .includes(sha);
      } catch (error) {
        if (error instanceof NoGitError) {
          throw error;
        }
        return false;
      }
    });
  }

  /**
   * Which of these files changed in the work-tree since `after` (edited,
   * deleted, or re-created). A turn-created file already deleted by hand
   * needs no warning: it's already in the state Undo wants.
   */
  public changedSince(files: ChangedFile[], after: string): Promise<string[]> {
    return this.enqueue(async () => {
      const changed: string[] = [];
      for (const file of files) {
        const current = await this.hashFile(join(this.workTree, file.path));
        const was = await this.blobAt(after, file.path);
        if (file.change === "added" && current === undefined) {
          continue;
        }
        if (current !== was) {
          changed.push(file.path);
        }
      }
      return changed;
    });
  }

  /** Restore files to their state in `before`; delete files the turn created. */
  public restore(files: ChangedFile[], before: string): Promise<RestoreResult> {
    return this.enqueue(async () => {
      const restored: string[] = [];
      const failed: string[] = [];
      const checkout: string[] = [];
      for (const file of files) {
        if (file.change === "added") {
          try {
            await unlink(join(this.workTree, file.path));
            restored.push(file.path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
              restored.push(file.path);
            } else {
              failed.push(file.path);
            }
          }
        } else {
          checkout.push(file.path);
        }
      }
      if (checkout.length > 0) {
        try {
          await this.git(["checkout", before, "--", ...checkout]);
          restored.push(...checkout);
        } catch {
          failed.push(...checkout);
        }
      }
      return { restored, failed };
    });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      try {
        try {
          await stat(join(this.gitDir, "HEAD"));
          return;
        } catch {
          // Fresh repo: init below.
        }
        await mkdir(this.gitDir, { recursive: true });
        try {
          await execFileAsync(this.gitBin, ["init", "--bare", this.gitDir], { cwd: this.workTree });
        } catch (error) {
          throwIfNoGit(error);
          throw error;
        }
        await writeFile(join(this.gitDir, "info", "exclude"), SHADOW_EXCLUDE, "utf8");
      } catch (error) {
        // Let the next call retry (git may be installed in the meantime).
        this.ready = undefined;
        throw error;
      }
    })();
    return this.ready;
  }

  private async prune(): Promise<void> {
    const out = (await this.git(["for-each-ref", "--format=%(refname)", "refs/shadows"])).trim();
    if (!out) {
      return;
    }
    // Timestamp-prefixed names sort oldest first.
    const refs = out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .sort();
    if (refs.length <= this.pruneAt) {
      return;
    }
    for (const ref of refs.slice(0, refs.length - this.keepSnapshots)) {
      await this.git(["update-ref", "-d", ref]);
    }
    await this.git(["gc", "--prune=now", "--quiet"]);
  }

  private async hashFile(full: string): Promise<string | undefined> {
    try {
      return (await this.git(["hash-object", full])).trim();
    } catch (error) {
      if (error instanceof NoGitError) {
        throw error;
      }
      return undefined;
    }
  }

  private async blobAt(after: string, path: string): Promise<string | undefined> {
    try {
      return (await this.git(["rev-parse", `${after}:${path}`])).trim();
    } catch (error) {
      if (error instanceof NoGitError) {
        throw error;
      }
      return undefined;
    }
  }

  private async git(args: string[]): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const { stdout } = await execFileAsync(
          this.gitBin,
          [`--git-dir=${this.gitDir}`, `--work-tree=${this.workTree}`, ...args],
          { cwd: this.workTree, maxBuffer: 10 * 1024 * 1024 },
        );
        return stdout;
      } catch (error) {
        lastError = error;
        throwIfNoGit(error);
        if (attempt >= 2 || !isLockError(error)) {
          throw error;
        }
        // Another window snapshotting at the same moment: wait it out.
        await sleep(250);
      }
    }
    throw lastError;
  }
}

/** "10:40" (24-hour) for undo lines. */
export function formatUndoTime(at: Date): string {
  const minutes = at.getMinutes();
  return `${at.getHours()}:${minutes < 10 ? "0" : ""}${minutes}`;
}

/** Work-tree relative paths of files over the size limit (forward slashes). */
async function bigFileExcludes(workTree: string): Promise<string[]> {
  const excludes: string[] = [];
  // Skipped names match info/exclude, so the walk agrees with what git takes.
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(join(dir, entry.name), entryRel);
      } else if (entry.isFile()) {
        try {
          if ((await stat(join(dir, entry.name))).size > LARGE_FILE_BYTES) {
            excludes.push(entryRel);
          }
        } catch {
          // Vanished mid-walk; ignore.
        }
      }
    }
  }
  await walk(workTree, "");
  return excludes;
}

/** Exclude the repo dir itself when it sits inside the work-tree, else undefined. */
function selfExclude(workTree: string, gitDir: string): string | undefined {
  const rel = relative(workTree, gitDir);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined;
  }
  return `:(exclude,literal)${rel.split(sep).join("/")}`;
}

function throwIfNoGit(error: unknown): void {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    throw new NoGitError();
  }
}

function isLockError(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown })?.stderr;
  return typeof stderr === "string" && stderr.includes(".lock");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
