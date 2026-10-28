// Finds the Muse binary. resolveMuseBin is pure (pass the directory
// listing in); findMuseBin reads this machine. No VS Code imports —
// the view reads the metaBetta.museBin setting and passes it in.

import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface MuseBinSearch {
  setting?: string;
  museDir: string;
  dirFiles: string[];
}

/** Setting → newest installed `muse-bin-*.exe` → `muse` on PATH. */
export function resolveMuseBin(search: MuseBinSearch): string {
  const setting = search.setting?.trim();
  if (setting) {
    return setting;
  }
  const newest = newestMuseBin(search.dirFiles);
  if (newest) {
    return join(search.museDir, newest);
  }
  return "muse";
}

/** Resolve the binary on this machine. */
export function findMuseBin(setting: string | undefined): string {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const museDir = join(localAppData, "Programs", "muse");
  let dirFiles: string[] = [];
  try {
    dirFiles = readdirSync(museDir);
  } catch {
    dirFiles = [];
  }
  return resolveMuseBin({ setting, museDir, dirFiles });
}

const BIN_PATTERN = /^muse-bin-(.+)\.exe$/i;

function newestMuseBin(files: string[]): string | undefined {
  let best: string | undefined;
  let bestVersion = "";
  for (const file of files) {
    const match = BIN_PATTERN.exec(file);
    if (!match) {
      continue;
    }
    if (best === undefined || compareVersions(match[1], bestVersion) > 0) {
      best = file;
      bestVersion = match[1];
    }
  }
  return best;
}

function compareVersions(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i += 1) {
    const aRaw = aParts[i] ?? "";
    const bRaw = bParts[i] ?? "";
    const aNum = aRaw === "" ? 0 : Number(aRaw);
    const bNum = bRaw === "" ? 0 : Number(bRaw);
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
      if (aNum !== bNum) {
        return aNum - bNum;
      }
    } else if (aRaw !== bRaw) {
      return aRaw.localeCompare(bRaw);
    }
  }
  return 0;
}
