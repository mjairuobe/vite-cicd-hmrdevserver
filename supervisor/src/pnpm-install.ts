import { execa, type ExecaError } from "execa";
import { access } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { constants as FS } from "node:fs";
import type { Logger } from "pino";
import { lockfileHash } from "./git-sync.js";

export type InstallResult = {
  ran: boolean;
  reason: "lockfile-changed" | "node_modules-missing" | "first-run" | "skipped";
  durationMs: number;
};

export type InstallOptions = {
  repoDir: string;
  /** Fallback, wenn sich das Repo nicht eindeutig per Lockfile/Workspaces erkennen lässt. */
  packageManager: "pnpm" | "npm" | "yarn";
  logger: Logger;
  /** Cached lockfile hash from previous install. Pass null to force install. */
  lastLockfileHash: string | null;
};

/**
 * npm-workspaces-Monorepos ohne pnpm-workspace.yaml: mit pnpm installieren liefert oft leere/kaputte node_modules.
 * Dann npm anhand package-lock nutzen.
 */
export function effectiveInstallPackageManager(
  repoDir: string,
  fallback: "pnpm" | "npm" | "yarn",
): "pnpm" | "npm" | "yarn" {
  const has = (f: string) => existsSync(join(repoDir, f));
  if (has("yarn.lock")) return "yarn";
  if (has("package-lock.json") && has("package.json")) {
    try {
      const raw = readFileSync(join(repoDir, "package.json"), "utf8");
      const pj = JSON.parse(raw) as { workspaces?: unknown };
      const ws = pj.workspaces;
      const hasWs = Array.isArray(ws) || (ws != null && typeof ws === "object");
      if (hasWs && !has("pnpm-workspace.yaml")) {
        return "npm";
      }
    } catch {
      /* ignore */
    }
  }
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("package-lock.json")) return "npm";
  return fallback;
}

async function nodeModulesPresent(repoDir: string): Promise<boolean> {
  const nm = join(repoDir, "node_modules");
  try {
    await access(nm, FS.F_OK);
  } catch {
    return false;
  }
  // Nur der Ordner reicht nicht: abgebrochene npm ci-Läufe hinterlassen leere/teilweise Trees —
  // Vite muss aus dem Repo-Root für mermaid-poc/vite.config.ts auflösbar sein.
  if (
    existsSync(join(repoDir, "mermaid-poc", "vite.config.ts")) ||
    existsSync(join(repoDir, "mermaid-poc", "vite.config.mts"))
  ) {
    return existsSync(join(repoDir, "node_modules", "vite", "package.json"));
  }
  return true;
}

export async function installIfNeeded(opts: InstallOptions): Promise<{
  result: InstallResult;
  newLockfileHash: string | null;
}> {
  const newHash = await lockfileHash(opts.repoDir);
  const hasNodeModules = await nodeModulesPresent(opts.repoDir);
  const start = Date.now();

  let reason: InstallResult["reason"] | null = null;
  if (!hasNodeModules) reason = "node_modules-missing";
  else if (opts.lastLockfileHash === null) reason = "first-run";
  else if (newHash !== opts.lastLockfileHash) reason = "lockfile-changed";

  if (!reason) {
    opts.logger.debug({ lockfileHash: newHash }, "install skipped");
    return {
      result: { ran: false, reason: "skipped", durationMs: 0 },
      newLockfileHash: newHash,
    };
  }

  const pm = effectiveInstallPackageManager(opts.repoDir, opts.packageManager);
  if (pm !== opts.packageManager) {
    opts.logger.info({ configured: opts.packageManager, effective: pm }, "package manager from repo layout");
  }
  const args = installArgs(pm);
  opts.logger.info({ pm, reason, args }, "running install");
  try {
    await runPackageManagerInstall(pm, args, opts.repoDir, opts.logger);
  } catch (err) {
    const e = err as ExecaError;
    opts.logger.error(
      { stderr: e.stderr, stdout: e.stdout, code: e.exitCode },
      "install failed",
    );
    throw new Error(`${pm} install failed: ${e.shortMessage ?? e.message}`);
  }

  const durationMs = Date.now() - start;
  opts.logger.info({ durationMs }, "install done");
  return {
    result: { ran: true, reason, durationMs },
    newLockfileHash: newHash,
  };
}

function installArgs(pm: "pnpm" | "npm" | "yarn"): string[] {
  switch (pm) {
    case "pnpm":
      return ["install", "--prefer-offline", "--reporter=append-only"];
    case "npm":
      // NODE_ENV=production (z. B. systemd-Unit) würde sonst devDependencies weglassen — Vite fehlt.
      return ["ci", "--include=dev", "--prefer-offline", "--no-audit", "--no-fund"];
    case "yarn":
      return ["install", "--frozen-lockfile", "--prefer-offline", "--non-interactive"];
  }
}

function isPnpmNotFound(err: unknown): boolean {
  const e = err as ExecaError & { code?: string };
  return e.code === "ENOENT" || (typeof e.shortMessage === "string" && e.shortMessage.includes("ENOENT"));
}

/**
 * systemd --user often has no pnpm on PATH; try corepack / npx before failing.
 */
async function runPackageManagerInstall(
  pm: "pnpm" | "npm" | "yarn",
  args: string[],
  cwd: string,
  logger: Logger,
): Promise<void> {
  const env = { CI: "1" };
  const stdio = { stdout: "pipe" as const, stderr: "pipe" as const };

  if (pm !== "pnpm") {
    await execa(pm, args, { cwd, env, ...stdio });
    return;
  }

  try {
    await execa("pnpm", args, { cwd, env, ...stdio });
  } catch (err) {
    if (!isPnpmNotFound(err)) throw err;
    logger.warn("pnpm binary not found on PATH; trying corepack pnpm");
    try {
      await execa("corepack", ["pnpm", ...args], { cwd, env, ...stdio });
    } catch (err2) {
      if (!isPnpmNotFound(err2)) throw err2;
      logger.warn("corepack pnpm unavailable; trying npx pnpm");
      await execa("npx", ["--yes", "pnpm", ...args], { cwd, env, ...stdio });
    }
  }
}
