import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Model id of the provider configured in src/agent/model.ts, e.g. "gpt-5.5".
  LLM_MODEL: z.string().regex(/^[\w.:-]+$/, 'Expected a model id such as "gpt-5.5" (no "provider/" prefix)'),
  LLM_API_KEY: z.string().min(1),
  // Base URLs of the A2A agents: their Agent Card is fetched from <url>/.well-known/agent-card.json.
  INFORMATIONS_AGENT_URL: z.url().default("http://127.0.0.1:8001"),
  ACTIONS_AGENT_URL: z.url().default("http://127.0.0.1:8002"),
  // TODO(auth): stand-in for an authenticated client (see middleware/clientIdentity.ts).
  DEMO_CLIENT_ID: z.string().min(1).default("c_001"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
