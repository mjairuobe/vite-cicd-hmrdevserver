import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import pino from "pino";
import { StateMachine } from "../../src/state-machine.js";
import { ViteController } from "../../src/vite-controller.js";

const logger = pino({ level: "silent" });

/** Picks an ephemeral free port to avoid colliding with concurrent tests. */
async function pickPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
  });
}

async function makeProject(dir: string): Promise<void> {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "demo", version: "0.0.0", type: "module" }, null, 2),
  );
  await writeFile(
    join(dir, "vite.config.ts"),
    `import { defineConfig } from "vite";\nexport default defineConfig({});\n`,
  );
  await writeFile(
    join(dir, "index.html"),
    `<!DOCTYPE html><html><body><div id="app">hi</div><script type="module" src="/src/main.ts"></script></body></html>`,
  );
  await writeFile(join(dir, "src", "main.ts"), `console.log("v1");\n`);
}

describe("vite integration", () => {
  let workDir: string;
  let port: number;
  let state: StateMachine;
  let vite: ViteController;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "vdr-int-"));
    await makeProject(workDir);
    // Symlink the supervisor's installed vite into the project so vite resolves it.
    await execa("ln", ["-s", join(process.cwd(), "node_modules"), join(workDir, "node_modules")]);
    port = await pickPort();
    state = new StateMachine("OFFLINE");
    vite = new ViteController({
      viteRoot: workDir,
      host: "127.0.0.1",
      port,
      logger,
      state,
      hmrQuietPeriodMs: 200,
      healthcheckIntervalMs: 60_000, // disable for the test
      healthcheckTimeoutMs: 1_000,
      healthcheckFailThreshold: 3,
    });
  });

  afterAll(async () => {
    await vite.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("starts vite and reaches READY", async () => {
    await vite.start();
    expect(state.current.state).toBe("READY");
  });

  it("serves the index over HTTP", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<div id=\"app\">");
  });

  it("transitions through HMR_UPDATING when a source file changes", async () => {
    const seenStates: string[] = [];
    state.on("transition", (ev) => seenStates.push(ev.to));

    // Give chokidar a moment to finish its initial scan; otherwise the first
    // change events can be silently dropped.
    await new Promise((r) => setTimeout(r, 800));

    // Force a full rewrite (some FS layers don't surface appendFile cleanly to inotify).
    await writeFile(join(workDir, "src", "main.ts"), `console.log("v2-${Date.now()}");\n`);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (seenStates.includes("HMR_UPDATING")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seenStates).toContain("HMR_UPDATING");
  });

  it("stops cleanly", async () => {
    await vite.stop();
    // After stop the controller does not emit OFFLINE itself; verify no listener crash.
    expect(vite.isRunning()).toBe(false);
  });
});
