import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { StateMachine } from "./state-machine.js";
import { ViteController } from "./vite-controller.js";
import { Orchestrator } from "./orchestrator.js";
import { registerAuth } from "./http/auth.js";
import { registerSync } from "./http/sync.js";
import { registerStatus } from "./http/status.js";
import { registerLifecycle } from "./http/lifecycle.js";
import { isPortInUse, killPortOwner } from "./port-utils.js";
import { resolveViteProjectRoot } from "./vite-project-root.js";

process.title = "vite-dev-remote-supervisor";

async function main(): Promise<void> {
  const config = loadConfig();
  const { logger, ring } = createLogger(config);

  const viteRoot = resolveViteProjectRoot(config.REPO_DIR, config.VITE_PROJECT_SUBDIR);
  logger.info(
    {
      supervisor: `${config.SUPERVISOR_HOST}:${config.SUPERVISOR_PORT}`,
      vite: `${config.VITE_HOST}:${config.VITE_PORT}`,
      repoDir: config.REPO_DIR,
      repoUrl: config.REPO_URL,
      viteRoot,
      viteBasePath: config.VITE_BASE_PATH,
      viteProjectSubdir: config.VITE_PROJECT_SUBDIR,
      trackedRef: config.TRACKED_REF,
      pm: config.PACKAGE_MANAGER,
    },
    "supervisor starting",
  );

  // Cold-boot: free Vite port if requested + occupied (catches lost cleanup case).
  if (await isPortInUse(config.VITE_HOST, config.VITE_PORT)) {
    if (config.KILL_PORT_OWNER_ON_START) {
      logger.warn({ port: config.VITE_PORT }, "vite port busy at boot — killing owner");
      await killPortOwner(config.VITE_PORT, logger);
    } else {
      logger.error({ port: config.VITE_PORT }, "vite port busy and KILL_PORT_OWNER_ON_START=false — aborting");
      process.exit(2);
    }
  }

  const state = new StateMachine("OFFLINE");
  const vite = new ViteController({
    viteRoot,
    base: config.VITE_BASE_PATH,
    host: config.VITE_HOST,
    port: config.VITE_PORT,
    logger: logger.child({ component: "vite" }),
    state,
    hmrQuietPeriodMs: config.HMR_QUIET_PERIOD_MS,
    healthcheckIntervalMs: config.HEALTHCHECK_INTERVAL_MS,
    healthcheckTimeoutMs: config.HEALTHCHECK_TIMEOUT_MS,
    healthcheckFailThreshold: config.HEALTHCHECK_FAIL_THRESHOLD,
  });

  const orchestrator = new Orchestrator({
    config,
    logger: logger.child({ component: "orchestrator" }),
    state,
    vite,
  });

  let shutdown: (exitCode: number) => Promise<void>;

  // Crash detection: if vite-controller exits unexpectedly, mark CRASHED.
  // (The in-process Vite makes this rare; main risk is unhandled exception.)
  process.on("uncaughtException", (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, "uncaughtException");
    const stateError: { msg: string; stack?: string } = { msg: err.message };
    if (err.stack !== undefined) stateError.stack = err.stack;
    try {
      state.forceTransition("CRASHED", { error: stateError });
    } catch { /* ignore */ }
    setImmediate(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ err: err.message, stack: err.stack }, "unhandledRejection");
  });

  const app = Fastify({ logger: false, disableRequestLogging: true });
  registerAuth(app, config.AUTH_SECRET);
  registerSync(app, orchestrator);
  registerStatus(app, state, ring);
  registerLifecycle(app, state, vite, {
    onStop: async () => {
      logger.info("shutdown via /stop");
      await shutdown(0);
    },
  });

  shutdown = async (exitCode: number): Promise<void> => {
    logger.info("shutting down");
    try {
      state.forceTransition("STOPPING");
    } catch { /* may not be allowed from current state — fine */ }
    try {
      await app.close();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "fastify close threw");
    }
    try {
      await vite.stop();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "vite stop threw");
    }
    try {
      state.forceTransition("OFFLINE");
    } catch { /* ignore */ }
    process.exit(exitCode);
  };

  await app.listen({ host: config.SUPERVISOR_HOST, port: config.SUPERVISOR_PORT });
  logger.info({ url: `http://${config.SUPERVISOR_HOST}:${config.SUPERVISOR_PORT}` }, "supervisor http listening");

  try {
    await orchestrator.coldBoot();
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, "cold boot failed");
    process.exit(3);
  }

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      logger.info({ sig }, "signal received");
      void shutdown(0);
    });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
