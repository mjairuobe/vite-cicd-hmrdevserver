import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),

  SUPERVISOR_HOST: z.string().default("127.0.0.1"),
  SUPERVISOR_PORT: z.coerce.number().int().min(1).max(65535).default(40890),

  VITE_HOST: z.string().default("127.0.0.1"),
  VITE_PORT: z.coerce.number().int().min(1).max(65535).default(40889),

  REPO_DIR: z.string().min(1),
  REPO_URL: z.string().min(1),
  TRACKED_REF: z.string().default("main"),

  PACKAGE_MANAGER: z.enum(["pnpm", "npm", "yarn"]).default("pnpm"),

  AUTH_SECRET: z.string().optional(),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_RING_SIZE: z.coerce.number().int().min(100).max(100_000).default(2_000),

  HEALTHCHECK_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
  HEALTHCHECK_TIMEOUT_MS: z.coerce.number().int().min(100).default(2_000),
  HEALTHCHECK_FAIL_THRESHOLD: z.coerce.number().int().min(1).default(3),

  HMR_QUIET_PERIOD_MS: z.coerce.number().int().min(0).default(750),

  KILL_PORT_OWNER_ON_START: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .default("false"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
