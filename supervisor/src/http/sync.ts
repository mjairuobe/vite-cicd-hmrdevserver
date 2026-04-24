import type { FastifyInstance } from "fastify";
import { Orchestrator, SyncBusyError } from "../orchestrator.js";

const SyncBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ref: { type: "string", minLength: 1 },
    force: { type: "boolean" },
  },
} as const;

export function registerSync(app: FastifyInstance, orchestrator: Orchestrator): void {
  app.post<{ Body: { ref?: string; force?: boolean } }>(
    "/sync",
    { schema: { body: SyncBodySchema } },
    async (req, reply) => {
      try {
        const body = req.body ?? {};
        const sync: { ref?: string; force?: boolean } = {};
        if (body.ref !== undefined) sync.ref = body.ref;
        if (body.force !== undefined) sync.force = body.force;
        const result = await orchestrator.beginSync(sync);
        reply.code(202).send(result);
      } catch (err) {
        if (err instanceof SyncBusyError) {
          reply.code(409).send({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );
}
