import { z } from "zod";

/** Vite public base path (z. B. /mermaid-poc/ wenn die App unter diesem URL-Pfad läuft). */
export function normalizeViteBasePath(input: string): string {
  const s = input.trim();
  if (s === "" || s === "/") return "/";
  const withLeading = s.startsWith("/") ? s : `/${s}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),

  SUPERVISOR_HOST: z.string().default("127.0.0.1"),
  SUPERVISOR_PORT: z.coerce.number().int().min(1).max(65535).default(40890),

  VITE_HOST: z.string().default("127.0.0.1"),
  VITE_PORT: z.coerce.number().int().min(1).max(65535).default(40889),

  REPO_DIR: z.string().min(1),
  REPO_URL: z.string().min(1),
  TRACKED_REF: z.string().default("main"),

  /** Relativer Pfad unter REPO_DIR zur Vite-App (Ordner mit vite.config / index.html). */
  VITE_PROJECT_SUBDIR: z.string().default("mermaid-poc"),

  /** URL-Pfad-Prefix der Vite-App (muss zu VITE_PROJECT_SUBDIR passen, z. B. /mermaid-poc/). */
  VITE_BASE_PATH: z
    .string()
    .default("/mermaid-poc/")
    .transform(normalizeViteBasePath),

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
