import type { Bot, Context } from "grammy";
import type { Message } from "grammy/types";
import type { BotServices } from "./services.js";
import type { Permissions } from "./permissions.js";
import { handleLinkSubmission } from "../commands/channels.js";
import { moderateGroupMessage } from "../moderation/handler.js";
import { convertChannelLinks } from "../message-handling.js";

export function registerMessageHandlers(bot: Bot, services: Pick<BotServices, "keywords" | "digestRepository">, permissions: Permissions): void {
  bot.on("message", async (ctx) => {
    if (ctx.from?.id === bot.botInfo.id) return;
    if (ctx.chat.type === "private") {
      await handleLinkSubmission(ctx, services, permissions);
      return;
    }
    await moderateGroupMessage(ctx, ctx.message, bot.botInfo.id, (text) => services.keywords.find(text));
  });

  bot.on("edited_message", async (ctx) => {
    await moderateGroupMessage(ctx, ctx.editedMessage, bot.botInfo.id, (text) => services.keywords.find(text), true);
  });

  async function handleChannelLinks(ctx: Context, message: Message): Promise<void> {
    try {
      await convertChannelLinks(ctx.api, message, bot.botInfo.id);
    } catch (error) {
      console.error(`[link-submission] 频道 ${message.chat.id} 消息 ${message.message_id} 转换失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  bot.on("channel_post", async (ctx) => {
    await handleChannelLinks(ctx, ctx.channelPost);
    const repository = services.digestRepository;

    const updated = repository.updateLatestMessageId(
      ctx.chat.id,
      ctx.channelPost.message_id,
    );
    if (updated) {
      console.log(
        `[digest] 已更新来源频道 ${ctx.chat.title} 的最新消息 ID：${ctx.channelPost.message_id}`,
      );
    }
  });

  bot.on("edited_channel_post", async (ctx) => {
    await handleChannelLinks(ctx, ctx.editedChannelPost);
  });

}
