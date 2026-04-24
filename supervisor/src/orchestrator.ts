import { Mutex } from "async-mutex";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { syncRepository, type GitSyncResult } from "./git-sync.js";
import { installIfNeeded } from "./pnpm-install.js";
import { isTerminalForSync, StateMachine, type State, type Snapshot } from "./state-machine.js";
import { ViteController } from "./vite-controller.js";

export class SyncBusyError extends Error {
  constructor() {
    super("Another sync is already in progress");
    this.name = "SyncBusyError";
  }
}

export type SyncRequest = {
  ref?: string;
  force?: boolean;
};

export type SyncStartResult = {
  runId: string;
  startedAt: string;
};

export type OrchestratorOptions = {
  config: Config;
  logger: Logger;
  state: StateMachine;
  vite: ViteController;
};

/**
 * Wires sync requests through git → install → vite, enforcing single-run mutex.
 * Returns immediately with a runId; the caller subscribes via SSE for completion.
 */
export class Orchestrator {
  private readonly mutex = new Mutex();
  private lastLockfileHash: string | null = null;
  private currentRunId: string | null = null;

  constructor(private readonly opts: OrchestratorOptions) {}

  isBusy(): boolean {
    return this.mutex.isLocked();
  }

  /** Cold-boot recovery: ensure repo is in good shape before starting Vite. */
  async coldBoot(): Promise<void> {
    this.opts.logger.info("cold boot: pulling baseline");
    const runId = `boot-${randomUUID()}`;
    this.currentRunId = runId;
    this.opts.vite.setRunId(runId);

    const sync = await syncRepository({
      repoDir: this.opts.config.REPO_DIR,
      repoUrl: this.opts.config.REPO_URL,
      ref: this.opts.config.TRACKED_REF,
      logger: this.opts.logger.child({ runId }),
    });
    this.opts.state.forceTransition("OFFLINE", { runId, lastCommit: sync.newHead });
    // OFFLINE -> STARTING is allowed by force.
    const install = await installIfNeeded({
      repoDir: this.opts.config.REPO_DIR,
      packageManager: this.opts.config.PACKAGE_MANAGER,
      logger: this.opts.logger.child({ runId, phase: "install" }),
      lastLockfileHash: this.lastLockfileHash,
    });
    this.lastLockfileHash = install.newLockfileHash;
    await this.opts.vite.start();
  }

  /**
   * Begin a sync run. Resolves immediately after the run is queued (or rejects with
   * SyncBusyError when another run is in flight and `force` is not set).
   * The actual work runs asynchronously; observers should follow `state`/SSE.
   */
  async beginSync(req: SyncRequest): Promise<SyncStartResult> {
    if (this.mutex.isLocked() && !req.force) {
      throw new SyncBusyError();
    }
    const runId = randomUUID();
    const startedAt = new Date().toISOString();

    // Schedule the actual sync — do not await the inner work, so the HTTP caller
    // gets a fast response with the runId and can subscribe to SSE.
    void this.runSyncSafely(runId, req).catch((err) => {
      this.opts.logger.error({ err: (err as Error).message, runId }, "unhandled sync failure");
    });

    return { runId, startedAt };
  }

  /** Wait until the state becomes terminal for a given runId, or timeout. */
  async waitForTerminal(runId: string, timeoutMs = 120_000): Promise<Snapshot> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snap = this.opts.state.current;
      if (snap.runId === runId && isTerminalForSync(snap.state)) return snap;
      await new Promise<void>((resolve) => {
        const onT = (): void => {
          this.opts.state.off("transition", onT);
          resolve();
        };
        this.opts.state.once("transition", onT);
        // Wakeup ceiling — also check periodically in case we missed an event.
        setTimeout(() => {
          this.opts.state.off("transition", onT);
          resolve();
        }, 1000);
      });
    }
    return this.opts.state.current;
  }

  private async runSyncSafely(runId: string, req: SyncRequest): Promise<void> {
    await this.mutex.runExclusive(async () => {
      this.currentRunId = runId;
      this.opts.vite.setRunId(runId);
      const ref = req.ref ?? this.opts.config.TRACKED_REF;
      const log = this.opts.logger.child({ runId, ref });
      log.info("sync run started");

      try {
        // PULLING
        this.opts.state.transition("PULLING", { runId, reason: `pull ${ref}`, error: null });
        const sync: GitSyncResult = await syncRepository({
          repoDir: this.opts.config.REPO_DIR,
          repoUrl: this.opts.config.REPO_URL,
          ref,
          logger: log,
        });

        // INSTALLING (conditional)
        if (sync.lockfileChanged || this.lastLockfileHash === null) {
          this.opts.state.transition("INSTALLING", { runId, reason: "lockfile changed", lastCommit: sync.newHead });
          const install = await installIfNeeded({
            repoDir: this.opts.config.REPO_DIR,
            packageManager: this.opts.config.PACKAGE_MANAGER,
            logger: log.child({ phase: "install" }),
            lastLockfileHash: this.lastLockfileHash,
          });
          this.lastLockfileHash = install.newLockfileHash;
        }

        // Decide next: CONFIG_RELOAD (restart Vite), or rely on file-watcher HMR.
        if (sync.configChanged) {
          await this.opts.vite.handleConfigChange();
          // handleConfigChange ends in READY or BUILD_ERROR via vite.start()
        } else if (sync.changedFiles.length === 0) {
          // No files changed (e.g. force-pull on same SHA). Just settle to READY.
          if (this.opts.state.current.state !== "READY") {
            // We came from PULLING/INSTALLING; transition table allows PULLING->READY and INSTALLING->READY.
            this.opts.state.transition("READY", { runId, reason: "no changes", lastCommit: sync.newHead });
          }
        } else {
          // Vite's file watcher will detect the changes from the git reset and emit HMR.
          // We give it a brief moment to fire, then if no transition happened, settle to READY.
          await sleep(this.opts.config.HMR_QUIET_PERIOD_MS);
          const cur = this.opts.state.current.state;
          if (cur === "PULLING" || cur === "INSTALLING") {
            // No HMR happened (probably because watcher already debounced) — go to READY.
            this.opts.state.transition("READY", { runId, reason: "no hmr fired", lastCommit: sync.newHead });
          }
          // Otherwise the state machine + ViteController will drive HMR_UPDATING -> ... -> READY.
        }

        log.info({ finalState: this.opts.state.current.state }, "sync run done");
      } catch (err) {
        const e = err as Error;
        log.error({ err: e.message }, "sync run failed");
        const cur = this.opts.state.current.state;
        if (cur === "PULLING" || cur === "INSTALLING") {
          this.opts.state.transition("BUILD_ERROR", {
            runId,
            error: { msg: e.message, ...(e.stack !== undefined ? { stack: e.stack } : {}) },
            reason: "sync failed",
          });
        }
      }
    });
  }
}
