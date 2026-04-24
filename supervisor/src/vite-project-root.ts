import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * REPO_DIR ist oft ein Monorepo-Root; Vite-App + index.html liegen in einem Unterordner.
 * Wenn dort eine vite.config liegt, diese nutzen — sonst Repo-Root (flaches Projekt).
 */
export function resolveViteProjectRoot(repoDir: string): string {
  const commonNested = join(repoDir, "mermaid-poc");
  if (existsSync(join(commonNested, "vite.config.ts")) || existsSync(join(commonNested, "vite.config.mts"))) {
    return commonNested;
  }
  if (existsSync(join(repoDir, "vite.config.ts")) || existsSync(join(repoDir, "vite.config.mts"))) {
    return repoDir;
  }
  return repoDir;
}
