import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * REPO_DIR ist oft ein Monorepo-Root; Vite-App + index.html liegen in VITE_PROJECT_SUBDIR.
 * Wenn dort keine vite.config liegt, flaches Repo-Root versuchen.
 */
export function resolveViteProjectRoot(repoDir: string, projectSubdir: string): string {
  const nested = join(repoDir, projectSubdir);
  if (existsSync(join(nested, "vite.config.ts")) || existsSync(join(nested, "vite.config.mts"))) {
    return nested;
  }
  if (existsSync(join(repoDir, "vite.config.ts")) || existsSync(join(repoDir, "vite.config.mts"))) {
    return repoDir;
  }
  return nested;
}
