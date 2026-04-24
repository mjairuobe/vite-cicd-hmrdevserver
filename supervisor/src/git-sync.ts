import { execa, type ExecaError } from "execa";
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { constants as FS } from "node:fs";
import type { Logger } from "pino";

export type GitSyncResult = {
  /** Files changed between previous HEAD and new HEAD (paths relative to repo root). */
  changedFiles: string[];
  /** Previous HEAD sha (null if repo was just cloned). */
  previousHead: string | null;
  /** New HEAD sha after pull. */
  newHead: string;
  /** True if the lockfile (pnpm-lock.yaml/package-lock.json/yarn.lock) changed. */
  lockfileChanged: boolean;
  /** True if vite.config.* / tsconfig*.json / package.json changed (requires Vite restart). */
  configChanged: boolean;
};

export type GitSyncOptions = {
  repoDir: string;
  repoUrl: string;
  ref: string;
  logger: Logger;
};

const CONFIG_FILE_PATTERNS = [
  /^vite\.config\.[mc]?[jt]s$/,
  /^tsconfig.*\.json$/,
  /^package\.json$/,
];

const LOCKFILE_NAMES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureRepo(opts: GitSyncOptions): Promise<{ wasFresh: boolean }> {
  const gitDir = join(opts.repoDir, ".git");
  if (await pathExists(gitDir)) return { wasFresh: false };
  opts.logger.info({ repoDir: opts.repoDir, repoUrl: opts.repoUrl }, "cloning repository");
  await execa("git", ["clone", "--no-checkout", opts.repoUrl, opts.repoDir], {
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  return { wasFresh: true };
}

async function currentHead(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function syncRepository(opts: GitSyncOptions): Promise<GitSyncResult> {
  const { wasFresh } = await ensureRepo(opts);
  const previousHead = wasFresh ? null : await currentHead(opts.repoDir);
  const env = { GIT_TERMINAL_PROMPT: "0" };

  try {
    await execa("git", ["fetch", "--prune", "--no-tags", "origin", opts.ref], {
      cwd: opts.repoDir,
      env,
    });
    await execa("git", ["reset", "--hard", `origin/${opts.ref}`], {
      cwd: opts.repoDir,
      env,
    });
    await execa("git", ["clean", "-fdx", "-e", "node_modules"], {
      cwd: opts.repoDir,
      env,
    });
  } catch (err) {
    const e = err as ExecaError;
    opts.logger.error(
      { stderr: e.stderr, stdout: e.stdout, code: e.exitCode },
      "git operation failed",
    );
    throw new Error(`git sync failed: ${e.shortMessage ?? e.message}`);
  }

  const newHead = (await currentHead(opts.repoDir)) ?? "";
  if (!newHead) throw new Error("git rev-parse HEAD failed after sync");

  let changedFiles: string[] = [];
  if (previousHead && previousHead !== newHead) {
    const { stdout } = await execa(
      "git",
      ["diff", "--name-only", previousHead, newHead],
      { cwd: opts.repoDir, env },
    );
    changedFiles = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } else if (!previousHead) {
    // Fresh clone — treat everything as changed.
    const { stdout } = await execa("git", ["ls-files"], { cwd: opts.repoDir, env });
    changedFiles = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  const lockfileChanged = changedFiles.some((f) => LOCKFILE_NAMES.includes(f));
  const configChanged = changedFiles.some((f) =>
    CONFIG_FILE_PATTERNS.some((re) => re.test(f)),
  );

  opts.logger.info(
    {
      previousHead,
      newHead,
      changedFiles: changedFiles.length,
      lockfileChanged,
      configChanged,
    },
    "git sync done",
  );

  return { changedFiles, previousHead, newHead, lockfileChanged, configChanged };
}

export async function lockfileHash(repoDir: string): Promise<string | null> {
  for (const name of LOCKFILE_NAMES) {
    const p = join(repoDir, name);
    if (await pathExists(p)) {
      const buf = await readFile(p);
      return createHash("sha256").update(buf).digest("hex");
    }
  }
  return null;
}
