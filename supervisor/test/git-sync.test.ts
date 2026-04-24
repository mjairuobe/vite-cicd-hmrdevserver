import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import pino from "pino";
import { syncRepository, lockfileHash } from "../src/git-sync.js";

const logger = pino({ level: "silent" });

async function makeBareRepo(): Promise<{ bare: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "vdr-bare-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  await mkdir(bare);
  await mkdir(seed);
  await execa("git", ["init", "--bare", "-b", "main"], { cwd: bare });
  await execa("git", ["init", "-b", "main"], { cwd: seed });
  await execa("git", ["config", "user.email", "t@t"], { cwd: seed });
  await execa("git", ["config", "user.name", "t"], { cwd: seed });
  await writeFile(join(seed, "src.ts"), "export const x = 1;\n");
  await writeFile(join(seed, "package.json"), JSON.stringify({ name: "p", version: "0.0.0" }, null, 2));
  await writeFile(join(seed, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await execa("git", ["add", "."], { cwd: seed });
  await execa("git", ["commit", "-m", "init"], { cwd: seed });
  await execa("git", ["remote", "add", "origin", bare], { cwd: seed });
  await execa("git", ["push", "-u", "origin", "main"], { cwd: seed });
  return {
    bare,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("git-sync", () => {
  let bare: string;
  let cleanup: () => Promise<void>;
  let workDir: string;

  beforeAll(async () => {
    const r = await makeBareRepo();
    bare = r.bare;
    cleanup = r.cleanup;
    workDir = await mkdtemp(join(tmpdir(), "vdr-work-"));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
    await cleanup();
  });

  it("clones a fresh repo on first sync and reports all files as changed", async () => {
    const result = await syncRepository({
      repoDir: workDir,
      repoUrl: bare,
      ref: "main",
      logger,
    });
    expect(result.previousHead).toBeNull();
    expect(result.newHead).toMatch(/^[0-9a-f]{40}$/);
    expect(result.changedFiles).toContain("src.ts");
    expect(result.changedFiles).toContain("package.json");
    expect(result.lockfileChanged).toBe(true);
    expect(result.configChanged).toBe(true); // package.json counts as config
  });

  it("detects file-level changes on subsequent pull", async () => {
    // Make a change in a fresh seed clone and push.
    const seed2 = await mkdtemp(join(tmpdir(), "vdr-seed2-"));
    await execa("git", ["clone", bare, seed2]);
    await execa("git", ["config", "user.email", "t@t"], { cwd: seed2 });
    await execa("git", ["config", "user.name", "t"], { cwd: seed2 });
    await writeFile(join(seed2, "src.ts"), "export const x = 2;\n");
    await execa("git", ["commit", "-am", "tweak"], { cwd: seed2 });
    await execa("git", ["push", "origin", "main"], { cwd: seed2 });

    const result = await syncRepository({
      repoDir: workDir,
      repoUrl: bare,
      ref: "main",
      logger,
    });
    expect(result.changedFiles).toEqual(["src.ts"]);
    expect(result.lockfileChanged).toBe(false);
    expect(result.configChanged).toBe(false);

    await rm(seed2, { recursive: true, force: true });
  });

  it("computes lockfile hash deterministically", async () => {
    const h1 = await lockfileHash(workDir);
    const h2 = await lockfileHash(workDir);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
