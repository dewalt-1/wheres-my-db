// Where the optional DB API key comes from, in this order:
//   1. environment variables DB_CLIENT_ID and DB_API_KEY (e.g. set in the
//      agent's MCP config);
//   2. the file written by `setup-db-api`:
//      $XDG_CONFIG_HOME/wheres-my-db/db-api.json (default ~/.config/...);
//   3. a .env file at the repository root (handy while developing).
// Nothing here ever prints the key.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DbCredentials {
  clientId: string;
  apiKey: string;
  /** Where they were found, for status messages. */
  source: "environment" | "config file" | ".env file";
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "wheres-my-db", "db-api.json");
}

/** Repository root .env, found relative to this file (src/db or dist/db). */
function repoEnvPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env");
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function loadDbCredentials(
  opts: { env?: NodeJS.ProcessEnv; envFile?: string } = {},
): DbCredentials | null {
  const env = opts.env ?? process.env;
  if (env.DB_CLIENT_ID && env.DB_API_KEY) {
    return { clientId: env.DB_CLIENT_ID, apiKey: env.DB_API_KEY, source: "environment" };
  }
  const file = configFilePath(env);
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { clientId?: unknown; apiKey?: unknown };
      if (typeof saved.clientId === "string" && typeof saved.apiKey === "string" && saved.clientId && saved.apiKey) {
        return { clientId: saved.clientId, apiKey: saved.apiKey, source: "config file" };
      }
    } catch {
      // Unreadable file: treat as not configured.
    }
  }
  const envFile = opts.envFile ?? repoEnvPath();
  if (existsSync(envFile)) {
    const values = parseEnvFile(readFileSync(envFile, "utf8"));
    if (values.DB_CLIENT_ID && values.DB_API_KEY) {
      return { clientId: values.DB_CLIENT_ID, apiKey: values.DB_API_KEY, source: ".env file" };
    }
  }
  return null;
}

/** Save to the config file, readable only by the current user. */
export function saveDbCredentials(
  creds: { clientId: string; apiKey: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const file = configFilePath(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ clientId: creds.clientId, apiKey: creds.apiKey }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function removeDbCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = configFilePath(env);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
