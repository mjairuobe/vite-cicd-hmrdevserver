import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";

const HEADER = "x-shared-secret";

export function registerAuth(app: FastifyInstance, secret: string | undefined): void {
  if (!secret) return;
  const expected = Buffer.from(secret, "utf8");

  app.addHook("preHandler", (req: FastifyRequest, reply: FastifyReply, done) => {
    // Read-only endpoints stay open even with auth set, so curl probing works locally.
    if (req.method === "GET") return done();
    if (req.url.startsWith("/healthz") || req.url.startsWith("/readyz")) return done();

    const got = req.headers[HEADER];
    if (typeof got !== "string") {
      reply.code(401).send({ error: "missing X-Shared-Secret" });
      return;
    }
    const provided = Buffer.from(got, "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      reply.code(403).send({ error: "invalid X-Shared-Secret" });
      return;
    }
    done();
  });
}
