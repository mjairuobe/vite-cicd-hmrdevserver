import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const minimal = {
  REPO_DIR: "/tmp/repo",
  REPO_URL: "git@github.com:org/p.git",
};

describe("config", () => {
  it("loads with defaults", () => {
    const c = loadConfig({ ...minimal });
    expect(c.SUPERVISOR_PORT).toBe(40890);
    expect(c.VITE_PORT).toBe(40889);
    expect(c.PACKAGE_MANAGER).toBe("pnpm");
    expect(c.TRACKED_REF).toBe("main");
    expect(c.AUTH_SECRET).toBeUndefined();
    expect(c.KILL_PORT_OWNER_ON_START).toBe(false);
  });

  it("coerces numeric env vars", () => {
    const c = loadConfig({ ...minimal, VITE_PORT: "8080", LOG_RING_SIZE: "500" });
    expect(c.VITE_PORT).toBe(8080);
    expect(c.LOG_RING_SIZE).toBe(500);
  });

  it("coerces boolean env vars", () => {
    const c = loadConfig({ ...minimal, KILL_PORT_OWNER_ON_START: "true" });
    expect(c.KILL_PORT_OWNER_ON_START).toBe(true);
  });

  it("rejects missing REPO_DIR", () => {
    expect(() => loadConfig({ REPO_URL: "x" })).toThrow(/REPO_DIR/);
  });

  it("rejects out-of-range ports", () => {
    expect(() => loadConfig({ ...minimal, VITE_PORT: "70000" })).toThrow();
  });
});
