import { Bot } from "grammy";
import type { BotConfig } from "./config.js";
import type { BotServices } from "./services.js";
import { createPermissions } from "./permissions.js";
import { registerKeywordCommands } from "../commands/keywords.js";
import { registerChannelCommands } from "../commands/channels.js";
import { registerCalendarCommands } from "../commands/calendar.js";
import { registerMessageHandlers } from "./messages.js";

// Construction does not access Telegram, files, or start scheduled work.
export function createBot(config: BotConfig, services: BotServices): Bot {
  const bot = new Bot(config.botToken);
  const permissions = createPermissions(services.admins);
  registerKeywordCommands(bot, services, permissions);
  registerChannelCommands(bot, services, permissions, config);
  registerCalendarCommands(bot, services, permissions);
  registerMessageHandlers(bot, services, permissions);
  return bot;
}
