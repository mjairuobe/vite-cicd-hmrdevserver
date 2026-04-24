import type { FastifyInstance } from "fastify";
import type { StateMachine } from "../state-machine.js";
import type { ViteController } from "../vite-controller.js";

export type LifecycleHooks = {
  onStop: () => Promise<void>;
};

export function registerLifecycle(
  app: FastifyInstance,
  state: StateMachine,
  vite: ViteController,
  hooks: LifecycleHooks,
): void {
  app.get("/healthz", async (_req, reply) => {
    reply.code(200).send({ ok: true, state: state.current.state });
  });

  app.get("/readyz", async (_req, reply) => {
    if (state.current.state === "READY") {
      reply.code(200).send({ ready: true });
    } else {
      reply.code(503).send({ ready: false, state: state.current.state });
    }
  });

  app.post("/restart", async (_req, reply) => {
    void vite.restart("api request").catch(() => {
      /* logged inside */
    });
    reply.code(202).send({ accepted: true });
  });

  app.post("/stop", async (_req, reply) => {
    reply.code(202).send({ accepted: true });
    // Schedule stop after the response is flushed.
    setImmediate(() => {
      void hooks.onStop();
    });
  });
}
