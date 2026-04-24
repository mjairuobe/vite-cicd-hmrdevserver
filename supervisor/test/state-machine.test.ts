import { describe, it, expect } from "vitest";
import { InvalidTransitionError, StateMachine, isTerminalForSync, STATES } from "../src/state-machine.js";

describe("StateMachine", () => {
  it("starts in OFFLINE by default", () => {
    const sm = new StateMachine();
    expect(sm.current.state).toBe("OFFLINE");
    expect(sm.current.runId).toBeNull();
    expect(sm.current.lastCommit).toBeNull();
  });

  it("rejects illegal transitions", () => {
    const sm = new StateMachine("READY");
    expect(() => sm.transition("OFFLINE")).toThrow(InvalidTransitionError);
    expect(() => sm.transition("INSTALLING")).toThrow(InvalidTransitionError);
  });

  it("allows the documented happy-path sync flow", () => {
    const sm = new StateMachine("READY");
    sm.transition("PULLING", { runId: "r1" });
    sm.transition("INSTALLING", { runId: "r1" });
    sm.transition("HMR_UPDATING", { runId: "r1" });
    sm.transition("HMR_APPLIED", { runId: "r1" });
    sm.transition("READY", { runId: "r1" });
    expect(sm.current.state).toBe("READY");
    expect(sm.current.runId).toBe("r1");
  });

  it("emits a transition event on every change", () => {
    const sm = new StateMachine("OFFLINE");
    const events: string[] = [];
    sm.on("transition", (ev) => events.push(`${ev.from}->${ev.to}`));
    sm.forceTransition("STARTING");
    sm.transition("READY");
    expect(events).toEqual(["OFFLINE->STARTING", "STARTING->READY"]);
  });

  it("forceTransition can move from non-OFFLINE to CRASHED", () => {
    const sm = new StateMachine("HMR_UPDATING");
    sm.forceTransition("CRASHED", { error: { msg: "vite died" } });
    expect(sm.current.state).toBe("CRASHED");
    expect(sm.current.error?.msg).toBe("vite died");
  });

  it("monotonically increases seq", () => {
    const sm = new StateMachine("OFFLINE");
    sm.forceTransition("STARTING");
    sm.transition("READY");
    sm.transition("PULLING");
    expect(sm.current.seq).toBe(3);
  });

  it("error is sticky across transitions; explicit null clears it", () => {
    const sm = new StateMachine("HMR_UPDATING");
    sm.transition("BUILD_ERROR", { error: { msg: "first" } });
    expect(sm.current.error?.msg).toBe("first");
    // Implicit transition does not wipe the error.
    sm.transition("HMR_UPDATING", { reason: "fix attempt" });
    expect(sm.current.error?.msg).toBe("first");
    // Explicit null clears it.
    sm.transition("HMR_APPLIED", { error: null });
    expect(sm.current.error).toBeNull();
  });

  it("isTerminalForSync covers READY/BUILD_ERROR/CRASHED only", () => {
    expect(isTerminalForSync("READY")).toBe(true);
    expect(isTerminalForSync("BUILD_ERROR")).toBe(true);
    expect(isTerminalForSync("CRASHED")).toBe(true);
    expect(isTerminalForSync("PULLING")).toBe(false);
    expect(isTerminalForSync("HMR_UPDATING")).toBe(false);
    expect(isTerminalForSync("READY")).toBe(true);
  });

  it("knows about all 14 declared states", () => {
    expect(STATES).toHaveLength(14);
  });
});
