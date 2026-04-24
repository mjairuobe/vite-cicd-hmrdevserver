import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveInstallPackageManager } from "../src/pnpm-install.js";

describe("effectiveInstallPackageManager", () => {
  it("npm workspaces ohne pnpm-workspace → npm trotz pnpm-lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "vdr-pm-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ private: true, workspaces: ["pkg"] }),
      );
      await writeFile(join(root, "package-lock.json"), "{}");
      await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      expect(effectiveInstallPackageManager(root, "pnpm")).toBe("npm");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pnpm-workspace vorhanden → pnpm", async () => {
    const root = await mkdtemp(join(tmpdir(), "vdr-pm2-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["a"] }));
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['a']\n");
      await writeFile(join(root, "pnpm-lock.yaml"), "x");
      expect(effectiveInstallPackageManager(root, "npm")).toBe("pnpm");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
