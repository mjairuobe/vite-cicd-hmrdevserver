import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveViteProjectRoot } from "../src/vite-project-root.js";

describe("resolveViteProjectRoot", () => {
  it("nutzt mermaid-poc wenn dort vite.config.ts liegt", async () => {
    const root = await mkdtemp(join(tmpdir(), "vdr-nested-"));
    try {
      const nested = join(root, "mermaid-poc");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "vite.config.ts"), "export default {}\n");
      expect(resolveViteProjectRoot(root)).toBe(nested);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("nutzt Repo-Root wenn nur dort vite.config.ts liegt", async () => {
    const root = await mkdtemp(join(tmpdir(), "vdr-flat-"));
    try {
      await writeFile(join(root, "vite.config.ts"), "export default {}\n");
      expect(resolveViteProjectRoot(root)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
