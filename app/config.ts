import { validate } from "node-cron";
import { MAX_DIGEST_SAMPLE_SIZE } from "../digest/types.js";
import { getLocalDate } from "../shared/time.js";

export interface BotConfig {
  botToken: string;
  keywordsFile: string;
  adminsFile: string;
  adminIds: ReadonlySet<number>;
  databaseFile: string;
  digestCron: string;
  digestTimeZone: string;
  digestSampleSize: number;
  digestSendMaxAttempts: number;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const botToken = env.BOT_TOKEN ?? "";
  if (!botToken) throw new Error("Missing BOT_TOKEN env var. Set BOT_TOKEN in your environment or .env file.");
  const digestCron = env.DIGEST_CRON ?? "0 12 * * *";
  const digestTimeZone = env.DIGEST_TIMEZONE ?? "Asia/Shanghai";
  if (!validate(digestCron)) throw new Error(`DIGEST_CRON is invalid: ${digestCron}`);
  getLocalDate(new Date(), digestTimeZone);
  return {
    botToken,
    keywordsFile: env.KEYWORDS_FILE ?? "./keywords.txt",
    adminsFile: env.ADMINS_FILE ?? "./admins.txt",
    adminIds: new Set((env.KEYWORD_ADMIN_IDS ?? "").split(",").map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)),
    databaseFile: env.DIGEST_DB_FILE ?? "./data/antiscambot.sqlite",
    digestCron,
    digestTimeZone,
    digestSampleSize: positiveInteger(env.DIGEST_SAMPLE_SIZE, 10, "DIGEST_SAMPLE_SIZE", MAX_DIGEST_SAMPLE_SIZE),
    digestSendMaxAttempts: positiveInteger(env.DIGEST_SEND_MAX_ATTEMPTS, 3, "DIGEST_SEND_MAX_ATTEMPTS", 10),
  };
}
