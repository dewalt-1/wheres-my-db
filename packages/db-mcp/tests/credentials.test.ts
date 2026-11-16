import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configFilePath,
  loadDbCredentials,
  removeDbCredentials,
  saveDbCredentials,
} from "../src/db/credentials.js";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "wmdb-"));
  return { dir, env: { XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv, missingEnvFile: join(dir, "none.env") };
}

describe("DB credentials", () => {
  it("returns null when nothing is configured", () => {
    const { env, missingEnvFile } = sandbox();
    expect(loadDbCredentials({ env, envFile: missingEnvFile })).toBeNull();
  });

  it("prefers environment variables over the saved file", () => {
    const { env, missingEnvFile } = sandbox();
    saveDbCredentials({ clientId: "file-id", apiKey: "file-key" }, env);
    const fromEnv = loadDbCredentials({ env: { ...env, DB_CLIENT_ID: "env-id", DB_API_KEY: "env-key" }, envFile: missingEnvFile });
    expect(fromEnv).toEqual({ clientId: "env-id", apiKey: "env-key", source: "environment" });
  });

  it("saves to the config file readable only by the user, loads it, and removes it", () => {
    const { env, missingEnvFile } = sandbox();
    const file = saveDbCredentials({ clientId: "id", apiKey: "secret" }, env);
    expect(file).toBe(configFilePath(env));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadDbCredentials({ env, envFile: missingEnvFile })).toEqual({ clientId: "id", apiKey: "secret", source: "config file" });
    expect(removeDbCredentials(env)).toBe(true);
    expect(loadDbCredentials({ env, envFile: missingEnvFile })).toBeNull();
  });

  it("falls back to a .env file", () => {
    const { dir, env } = sandbox();
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "# comment\nDB_CLIENT_ID=abc\nDB_API_KEY = \"xyz\"\n");
    expect(loadDbCredentials({ env, envFile })).toEqual({ clientId: "abc", apiKey: "xyz", source: ".env file" });
  });

  it("ignores half-filled settings", () => {
    const { dir, env } = sandbox();
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "DB_CLIENT_ID=abc\n");
    expect(loadDbCredentials({ env: { ...env, DB_CLIENT_ID: "only-id" }, envFile })).toBeNull();
  });
});
