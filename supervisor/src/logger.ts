import pino, { type Logger, type LoggerOptions, type DestinationStream } from "pino";
import type { Config } from "./config.js";

export type RingEntry = {
  seq: number;
  ts: string;
  level: number;
  levelLabel: string;
  msg: string;
  runId?: string;
  state?: string;
  extra?: Record<string, unknown>;
};

export class LogRing {
  private readonly buf: (RingEntry | undefined)[];
  private idx = 0;
  private filled = false;
  private nextSeq = 1;

  constructor(private readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  push(entry: Omit<RingEntry, "seq">): void {
    this.buf[this.idx] = { seq: this.nextSeq++, ...entry };
    this.idx = (this.idx + 1) % this.capacity;
    if (this.idx === 0) this.filled = true;
  }

  /** Returns entries in chronological order, optionally only those after `sinceSeq`. */
  tail(sinceSeq?: number, limit = 500): RingEntry[] {
    const out: RingEntry[] = [];
    const total = this.filled ? this.capacity : this.idx;
    for (let i = 0; i < total; i++) {
      const slot = this.filled ? (this.idx + i) % this.capacity : i;
      const entry = this.buf[slot];
      if (!entry) continue;
      if (sinceSeq !== undefined && entry.seq <= sinceSeq) continue;
      out.push(entry);
    }
    if (out.length > limit) return out.slice(out.length - limit);
    return out;
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }
}

function makeRingStream(ring: LogRing): DestinationStream {
  const KNOWN = new Set(["level", "time", "msg", "v", "pid", "hostname", "svc"]);
  return {
    write(line: string): void {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const level = typeof obj["level"] === "number" ? (obj["level"] as number) : 30;
        const ts = typeof obj["time"] === "string" ? (obj["time"] as string) : new Date().toISOString();
        const msg = typeof obj["msg"] === "string" ? (obj["msg"] as string) : "";
        const extra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (!KNOWN.has(k)) extra[k] = v;
        }
        const entry: Omit<RingEntry, "seq"> = {
          ts,
          level,
          levelLabel: pino.levels.labels[level] ?? "info",
          msg,
        };
        if (typeof obj["runId"] === "string") entry.runId = obj["runId"] as string;
        if (typeof obj["state"] === "string") entry.state = obj["state"] as string;
        if (Object.keys(extra).length > 0) entry.extra = extra;
        ring.push(entry);
      } catch {
        // Non-JSON line (shouldn't happen with our config) — skip silently.
      }
    },
  };
}

export function createLogger(config: Config): { logger: Logger; ring: LogRing } {
  const ring = new LogRing(config.LOG_RING_SIZE);

  const baseOpts: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { svc: "vite-dev-remote-supervisor" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  const ringStream = makeRingStream(ring);
  const stdoutStream: DestinationStream = pino.destination({ sync: false });

  const logger = pino(
    baseOpts,
    pino.multistream([
      { stream: stdoutStream, level: config.LOG_LEVEL },
      { stream: ringStream, level: config.LOG_LEVEL },
    ]),
  );

  return { logger, ring };
}
