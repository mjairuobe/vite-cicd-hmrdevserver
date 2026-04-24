import { execa } from "execa";
import { createConnection } from "node:net";
import type { Logger } from "pino";

export async function isPortInUse(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const t = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(t);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/** Best-effort kill of any process holding the port. Logs but never throws. */
export async function killPortOwner(port: number, logger: Logger): Promise<void> {
  try {
    const { stdout } = await execa("fuser", ["-k", `${port}/tcp`]);
    logger.warn({ port, stdout }, "killed port owner");
  } catch (err) {
    logger.debug({ port, err: (err as Error).message }, "fuser found no owner");
  }
}
