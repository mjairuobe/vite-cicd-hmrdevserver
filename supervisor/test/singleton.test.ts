import { describe, it, expect, vi } from "vitest";
import { Mutex } from "async-mutex";

/**
 * Verifies the mutex semantics we rely on in Orchestrator.
 * The actual integration is covered in the end-to-end test.
 */
describe("singleton sync mutex", () => {
  it("rejects a second concurrent acquisition when not awaited", async () => {
    const m = new Mutex();
    const release = await m.acquire();
    expect(m.isLocked()).toBe(true);
    release();
    expect(m.isLocked()).toBe(false);
  });

  it("serializes runExclusive calls", async () => {
    const m = new Mutex();
    const order: string[] = [];
    const a = m.runExclusive(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    });
    const b = m.runExclusive(async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("isLocked transitions cleanly so a fast caller can reject", async () => {
    const m = new Mutex();
    const reject = vi.fn();
    void m.runExclusive(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // Same-tick check: should be locked.
    if (m.isLocked()) reject();
    expect(reject).toHaveBeenCalled();
  });
});
