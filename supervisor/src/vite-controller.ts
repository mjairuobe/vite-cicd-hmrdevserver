import { createServer, type ViteDevServer } from "vite";
import type { Logger } from "pino";
import { request as httpRequest } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { StateMachine, type StateError } from "./state-machine.js";

export type ViteControllerOptions = {
  /** Verzeichnis mit index.html + vite.config (kann Unterordner des Git-Repo sein). */
  viteRoot: string;
  /** Vite `base` (öffentlicher URL-Pfad, z. B. /mermaid-poc/). */
  base: string;
  host: string;
  port: number;
  logger: Logger;
  state: StateMachine;
  hmrQuietPeriodMs: number;
  healthcheckIntervalMs: number;
  healthcheckTimeoutMs: number;
  healthcheckFailThreshold: number;
};

/**
 * Owns the Vite dev server lifecycle. Bridges Vite events to the StateMachine.
 *
 * Single-responsibility:
 *  - start/stop/restart the in-process Vite server
 *  - subscribe to file changes + ws errors and translate to state transitions
 *  - run a periodic healthcheck against the listening port
 */
export class ViteController {
  private server: ViteDevServer | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthFailCount = 0;
  private hmrSettleTimer: NodeJS.Timeout | null = null;
  private currentRunId: string | null = null;
  private stopping = false;

  constructor(private readonly opts: ViteControllerOptions) {}

  isRunning(): boolean {
    return this.server !== null;
  }

  setRunId(runId: string | null): void {
    this.currentRunId = runId;
  }

  async start(): Promise<void> {
    if (this.server) {
      this.opts.logger.warn("vite already running, ignoring start()");
      return;
    }
    this.stopping = false;
    this.opts.state.forceTransition("STARTING", { runId: this.currentRunId, reason: "start" });

    try {
      this.server = await createServer({
        root: this.opts.viteRoot,
        base: this.opts.base,
        server: {
          host: this.opts.host,
          port: this.opts.port,
          strictPort: true,
          hmr: { host: this.opts.host, port: this.opts.port },
        },
        clearScreen: false,
        logLevel: "info",
        appType: "spa",
      });

      this.bindEvents(this.server);
      await this.server.listen();
      this.opts.logger.info(
        { host: this.opts.host, port: this.opts.port },
        "vite listening",
      );
      this.opts.state.transition("READY", { runId: this.currentRunId, reason: "vite listening" });
      this.startHealthcheck();
    } catch (err) {
      const e = err as Error;
      this.opts.logger.error({ err: e.message }, "vite failed to start");
      const stateError: StateError = { msg: e.message };
      if (e.stack !== undefined) stateError.stack = e.stack;
      this.opts.state.transition("BUILD_ERROR", {
        runId: this.currentRunId,
        error: stateError,
        reason: "startup error",
      });
      this.server = null;
    }
  }

  private bindEvents(server: ViteDevServer): void {
    // File change → HMR or full reload (Vite decides internally; we observe via ws send hook).
    server.watcher.on("change", (path) => {
      this.opts.logger.debug({ path }, "file change detected");
      this.beginHmr();
    });
    server.watcher.on("add", (path) => {
      this.opts.logger.debug({ path }, "file added");
      this.beginHmr();
    });

    // Vite WS errors are surfaced through the ws send pipeline; we tap by intercepting
    // payload broadcasts. The public API is server.ws.send(payload).
    const originalSend = server.ws.send.bind(server.ws);
    server.ws.send = ((payload: unknown) => {
      try {
        const p = payload as { type?: string; err?: { message?: string; loc?: { file?: string; line?: number; column?: number } } };
        if (p?.type === "error" && p.err) {
          const stateError: StateError = { msg: p.err.message ?? "vite build error" };
          if (p.err.loc?.file !== undefined) stateError.file = p.err.loc.file;
          if (p.err.loc?.line !== undefined) stateError.line = p.err.loc.line;
          if (p.err.loc?.column !== undefined) stateError.column = p.err.loc.column;
          this.handleBuildError(stateError);
        } else if (p?.type === "full-reload") {
          this.handleFullReload();
        } else if (p?.type === "update") {
          this.handleHmrApplied();
        }
      } catch (err) {
        this.opts.logger.warn({ err: (err as Error).message }, "ws send hook error");
      }
      return originalSend(payload as Parameters<typeof originalSend>[0]);
    }) as typeof server.ws.send;
  }

  private beginHmr(): void {
    const cur = this.opts.state.current.state;
    if (cur === "READY" || cur === "BUILD_ERROR") {
      try {
        this.opts.state.transition("HMR_UPDATING", {
          runId: this.currentRunId,
          reason: "file change",
          error: null,
        });
      } catch {
        // race — ignore
      }
    }
  }

  private handleBuildError(error: StateError): void {
    const cur = this.opts.state.current.state;
    if (cur === "HMR_UPDATING" || cur === "STARTING" || cur === "FULL_RELOAD") {
      this.opts.state.transition("BUILD_ERROR", { runId: this.currentRunId, error });
    } else if (cur === "READY") {
      // Direct error without HMR_UPDATING (e.g. typecheck on save). Force via HMR_UPDATING.
      try {
        this.opts.state.transition("HMR_UPDATING", { runId: this.currentRunId, reason: "build error in ready" });
      } catch { /* ignore race */ }
      this.opts.state.transition("BUILD_ERROR", { runId: this.currentRunId, error });
    }
  }

  private handleFullReload(): void {
    const cur = this.opts.state.current.state;
    if (cur === "HMR_UPDATING") {
      this.opts.state.transition("FULL_RELOAD", { runId: this.currentRunId });
      this.scheduleSettle("FULL_RELOAD_DONE");
    }
  }

  private handleHmrApplied(): void {
    const cur = this.opts.state.current.state;
    if (cur === "HMR_UPDATING") {
      this.opts.state.transition("HMR_APPLIED", { runId: this.currentRunId });
      this.scheduleSettle("HMR_APPLIED");
    }
  }

  private scheduleSettle(via: "HMR_APPLIED" | "FULL_RELOAD_DONE"): void {
    if (this.hmrSettleTimer) clearTimeout(this.hmrSettleTimer);
    this.hmrSettleTimer = setTimeout(() => {
      const cur = this.opts.state.current.state;
      if (via === "FULL_RELOAD_DONE" && cur === "FULL_RELOAD") {
        this.opts.state.transition("FULL_RELOAD_DONE", { runId: this.currentRunId });
      }
      const after = this.opts.state.current.state;
      if (after === "HMR_APPLIED" || after === "FULL_RELOAD_DONE") {
        this.opts.state.transition("READY", { runId: this.currentRunId, reason: "settled" });
      }
    }, this.opts.hmrQuietPeriodMs);
  }

  private startHealthcheck(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthFailCount = 0;
    this.healthTimer = setInterval(() => void this.healthcheckTick(), this.opts.healthcheckIntervalMs);
  }

  private async healthcheckTick(): Promise<void> {
    if (!this.server || this.stopping) return;
    const ok = await this.probe();
    const cur = this.opts.state.current.state;
    if (ok) {
      this.healthFailCount = 0;
      if (cur === "UNHEALTHY") {
        try {
          this.opts.state.transition("READY", { runId: this.currentRunId, reason: "health restored" });
        } catch {
          // not reachable from UNHEALTHY directly in some cases — ignore
        }
      }
      return;
    }
    this.healthFailCount += 1;
    this.opts.logger.warn({ fails: this.healthFailCount }, "healthcheck failed");
    if (
      this.healthFailCount >= this.opts.healthcheckFailThreshold &&
      cur === "READY"
    ) {
      this.opts.state.transition("UNHEALTHY", { runId: this.currentRunId, reason: "healthcheck threshold" });
      // Trigger restart in background.
      void this.restart("unhealthy");
    }
  }

  /** Pfad der SPA-Root (bei base /mermaid-poc/ → /mermaid-poc/). */
  private healthCheckPath(): string {
    const b = this.opts.base;
    if (b === "/") return "/";
    return b.endsWith("/") ? b : `${b}/`;
  }

  private probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = httpRequest(
        {
          host: this.opts.host,
          port: this.opts.port,
          path: this.healthCheckPath(),
          method: "HEAD",
          timeout: this.opts.healthcheckTimeoutMs,
        },
        (res) => {
          res.resume();
          resolve((res.statusCode ?? 0) < 500);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  async restart(reason: string): Promise<void> {
    this.opts.logger.info({ reason }, "restarting vite");
    await this.stop();
    // brief pause to let port free up cleanly
    await sleep(200);
    await this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.hmrSettleTimer) {
      clearTimeout(this.hmrSettleTimer);
      this.hmrSettleTimer = null;
    }
    if (!this.server) return;
    try {
      await this.server.close();
    } catch (err) {
      this.opts.logger.warn({ err: (err as Error).message }, "vite close threw");
    }
    this.server = null;
  }

  async handleConfigChange(): Promise<void> {
    this.opts.state.forceTransition("CONFIG_RELOAD", { runId: this.currentRunId, reason: "vite config changed" });
    await this.restart("config change");
  }
}
