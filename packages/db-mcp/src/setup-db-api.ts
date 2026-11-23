// Terminal commands for the optional DB API key. Run them in a terminal,
// never through an AI agent: the key should not pass through a chat.
//
//   node packages/db-mcp/dist/index.js setup-db-api    save and check a key
//   node packages/db-mcp/dist/index.js db-api-status   is a key set, does it work?
//   node packages/db-mcp/dist/index.js remove-db-api   delete the saved key

import { createInterface } from "node:readline";
import { OpenBoardsClient } from "./clients/open-boards.js";
import { ProviderError } from "./errors.js";
import { configFilePath, loadDbCredentials, removeDbCredentials, saveDbCredentials } from "./db/credentials.js";

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Print the question, then swallow the echo of what is typed.
      const out = rl as unknown as { _writeToOutput: (s: string) => void };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

/** One cheap call that proves the key and the OpenBoards subscription work. */
async function check(clientId: string, apiKey: string): Promise<string | null> {
  try {
    const now = Date.now();
    await new OpenBoardsClient({ clientId, apiKey }).getBoard("de:05315:11201", now, now + 30 * 60_000); // Köln Hbf
    return null;
  } catch (err) {
    return err instanceof ProviderError ? err.message : (err as Error).message;
  }
}

async function setup(): Promise<number> {
  console.log("Save a DB API key so train answers include DB's notices (delay reasons, catering, coaches).");
  console.log("Get a free key at https://developers.deutschebahn.com (see the README, \"Using the DB API\").\n");
  const clientId = await ask("Client ID: ");
  const apiKey = await ask("Client Secret (hidden): ", true);
  if (!clientId || !apiKey) {
    console.log("Both values are needed. Nothing was saved.");
    return 1;
  }
  process.stdout.write("Checking the key with DB… ");
  const problem = await check(clientId, apiKey);
  if (problem) {
    console.log(`failed: ${problem}\nNothing was saved.`);
    return 1;
  }
  console.log("works.");
  const file = saveDbCredentials({ clientId, apiKey });
  console.log(`Saved to ${file} (readable only by you).`);
  console.log("Restart your agent so it picks up the key.");
  return 0;
}

async function status(): Promise<number> {
  const creds = loadDbCredentials();
  if (!creds) {
    console.log("No DB API key set. Train answers work, without DB notices.");
    console.log("Add one with: node packages/db-mcp/dist/index.js setup-db-api");
    return 1;
  }
  process.stdout.write(`DB API key found (${creds.source}). Checking it with DB… `);
  const problem = await check(creds.clientId, creds.apiKey);
  console.log(problem ? `failed: ${problem}` : "works.");
  return problem ? 1 : 0;
}

function remove(): number {
  const removed = removeDbCredentials();
  console.log(removed ? `Removed ${configFilePath()}.` : "No saved key to remove.");
  if (process.env.DB_CLIENT_ID || process.env.DB_API_KEY) {
    console.log("Note: DB_CLIENT_ID / DB_API_KEY are also set in your environment or agent config; remove them there too.");
  }
  return 0;
}

export async function runCommand(command: string): Promise<number | undefined> {
  if (command === "setup-db-api") return setup();
  if (command === "db-api-status") return status();
  if (command === "remove-db-api") return remove();
  return undefined;
}
