import "dotenv/config";
import { readConfig } from "./app/config.js";
import { runBot } from "./app/runtime.js";

async function main(): Promise<void> {
  await runBot(readConfig());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
