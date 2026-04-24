import type { FastifyInstance, FastifyReply } from "fastify";
import type { Snapshot, StateMachine, TransitionEvent } from "../state-machine.js";
import type { LogRing } from "../logger.js";

export function registerStatus(
  app: FastifyInstance,
  state: StateMachine,
  ring: LogRing,
): void {
  app.get("/status", async () => state.current);

  app.get<{ Querystring: { runId?: string } }>("/events", (req, reply) => {
    const runIdFilter = req.query.runId;
    setupSse(reply);

    const send = (event: TransitionEvent | { type: "snapshot"; data: Snapshot }): void => {
      const data = JSON.stringify(event);
      reply.raw.write(`data: ${data}\n\n`);
    };

    // Initial snapshot so a late subscriber sees current state immediately.
    send({ type: "snapshot", data: state.current });

    const onTransition = (ev: TransitionEvent): void => {
      if (runIdFilter && ev.runId !== runIdFilter) return;
      send(ev);
      // Auto-close on terminal state for the requested runId.
      if (
        runIdFilter &&
        ev.runId === runIdFilter &&
        (ev.to === "READY" || ev.to === "BUILD_ERROR" || ev.to === "CRASHED")
      ) {
        teardown();
      }
    };

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: keepalive\n\n`);
      } catch {
        teardown();
      }
    }, 15_000);

    state.on("transition", onTransition);
    const teardown = (): void => {
      clearInterval(heartbeat);
      state.off("transition", onTransition);
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    };
    req.raw.on("close", teardown);
    req.raw.on("error", teardown);
  });

  app.get<{ Querystring: { sinceSeq?: string; limit?: string } }>(
    "/logs",
    async (req) => {
      const sinceSeq = req.query.sinceSeq ? Number(req.query.sinceSeq) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 500;
      return {
        latestSeq: ring.latestSeq,
        entries: ring.tail(sinceSeq, Math.min(Math.max(limit, 1), 5_000)),
      };
    },
  );
}

function setupSse(reply: FastifyReply): void {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.flushHeaders();
}
