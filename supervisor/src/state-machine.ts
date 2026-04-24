import { EventEmitter } from "node:events";

export const STATES = [
  "OFFLINE",
  "STARTING",
  "READY",
  "PULLING",
  "INSTALLING",
  "CONFIG_RELOAD",
  "HMR_UPDATING",
  "HMR_APPLIED",
  "FULL_RELOAD",
  "FULL_RELOAD_DONE",
  "BUILD_ERROR",
  "UNHEALTHY",
  "CRASHED",
  "STOPPING",
] as const;

export type State = (typeof STATES)[number];

export type StateError = {
  file?: string;
  line?: number;
  column?: number;
  msg: string;
  stack?: string;
};

export type Snapshot = {
  state: State;
  since: string;
  runId: string | null;
  lastCommit: string | null;
  error: StateError | null;
  /** monotonically increasing sequence number per transition */
  seq: number;
};

export type TransitionEvent = {
  from: State;
  to: State;
  at: string;
  runId: string | null;
  reason?: string;
  error?: StateError;
};

/**
 * Allowed transitions. Anything not listed throws InvalidTransitionError.
 * Transitions to CRASHED and STOPPING are allowed from any non-terminal state
 * (handled separately via `forceTransition`).
 */
const TRANSITIONS: Readonly<Record<State, ReadonlyArray<State>>> = {
  OFFLINE: ["STARTING"],
  STARTING: ["READY", "BUILD_ERROR"],
  READY: ["PULLING", "HMR_UPDATING", "UNHEALTHY"],
  PULLING: ["INSTALLING", "CONFIG_RELOAD", "HMR_UPDATING", "BUILD_ERROR", "READY"],
  INSTALLING: ["CONFIG_RELOAD", "HMR_UPDATING", "BUILD_ERROR", "READY"],
  CONFIG_RELOAD: ["STARTING", "BUILD_ERROR"],
  HMR_UPDATING: ["HMR_APPLIED", "FULL_RELOAD", "BUILD_ERROR"],
  HMR_APPLIED: ["READY"],
  FULL_RELOAD: ["FULL_RELOAD_DONE", "BUILD_ERROR"],
  FULL_RELOAD_DONE: ["READY"],
  BUILD_ERROR: ["HMR_UPDATING", "PULLING", "READY", "STARTING"],
  UNHEALTHY: ["STARTING", "READY"],
  CRASHED: ["STARTING"],
  STOPPING: ["OFFLINE"],
};

export class InvalidTransitionError extends Error {
  constructor(from: State, to: State) {
    super(`Invalid state transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class StateMachine extends EventEmitter {
  private snap: Snapshot;
  private seq = 0;

  constructor(initial: State = "OFFLINE") {
    super();
    this.snap = {
      state: initial,
      since: new Date().toISOString(),
      runId: null,
      lastCommit: null,
      error: null,
      seq: 0,
    };
  }

  get current(): Snapshot {
    return { ...this.snap };
  }

  /**
   * Set runId / lastCommit without changing state (e.g. cold boot after git sync while still OFFLINE).
   */
  setRunMetadata(opts: { runId?: string | null; lastCommit?: string | null }): void {
    if (opts.runId !== undefined) this.snap.runId = opts.runId;
    if (opts.lastCommit !== undefined) this.snap.lastCommit = opts.lastCommit;
  }

  isAllowed(to: State): boolean {
    return TRANSITIONS[this.snap.state].includes(to);
  }

  /**
   * Normal transition. Throws if `to` is not in the allowed set for the current state.
   * For unconditional transitions (CRASHED, STOPPING) use {@link forceTransition}.
   */
  transition(to: State, opts: { runId?: string | null; reason?: string; error?: StateError | null; lastCommit?: string | null } = {}): void {
    if (!this.isAllowed(to)) {
      throw new InvalidTransitionError(this.snap.state, to);
    }
    this.applyTransition(to, opts);
  }

  /**
   * Used for CRASHED, STOPPING, and recovery — bypasses the transition table.
   * Still rejects transitions away from OFFLINE that aren't STARTING (sanity).
   */
  forceTransition(to: State, opts: { runId?: string | null; reason?: string; error?: StateError | null; lastCommit?: string | null } = {}): void {
    if (this.snap.state === to) {
      return;
    }
    if (this.snap.state === "OFFLINE" && to !== "STARTING") {
      throw new InvalidTransitionError(this.snap.state, to);
    }
    this.applyTransition(to, opts);
  }

  private applyTransition(to: State, opts: { runId?: string | null; reason?: string; error?: StateError | null; lastCommit?: string | null }): void {
    const from = this.snap.state;
    const at = new Date().toISOString();
    this.seq += 1;
    const next: Snapshot = {
      state: to,
      since: at,
      runId: opts.runId !== undefined ? opts.runId : this.snap.runId,
      lastCommit: opts.lastCommit !== undefined ? opts.lastCommit : this.snap.lastCommit,
      // Error is sticky by default — only changes when opts.error is explicitly set
      // (pass `null` to clear). This lets BUILD_ERROR persist across observation
      // transitions until a fresh build / explicit clear happens.
      error: opts.error !== undefined ? opts.error : this.snap.error,
      seq: this.seq,
    };
    this.snap = next;
    const ev: TransitionEvent = { from, to, at, runId: next.runId };
    if (opts.reason !== undefined) ev.reason = opts.reason;
    if (next.error) ev.error = next.error;
    this.emit("transition", ev);
  }
}

export const TERMINAL_STATES_FOR_SYNC: ReadonlyArray<State> = [
  "READY",
  "BUILD_ERROR",
  "CRASHED",
];

export function isTerminalForSync(state: State): boolean {
  return TERMINAL_STATES_FOR_SYNC.includes(state);
}
