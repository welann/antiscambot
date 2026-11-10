import type { Api, Bot } from "grammy";
import { parseTelegramMessageLink } from "../digest/formatting.js";
import type { LinkKind } from "../digest/types.js";

function canonicalPrivateLinkChannel(chatId: number): string {
  const value = String(chatId);
  if (!value.startsWith("-100") || value.length <= 4) {
    throw new Error(`频道 ID 无法转换为私有消息链接：${chatId}`);
  }
  return value.slice(4);
}

type ResolvedManagedChannel = {
  chatId: number;
  title: string;
  username: string | null;
  linkKind: LinkKind;
  linkChannel: string;
  messageId: number;
};

export async function resolveManagedChannel(
  api: Pick<Api, "getChat" | "getChatMember">,
  botId: number,
  rawLink: string,
  requirePostingPermission: boolean,
  requireEditingPermission = false,
): Promise<ResolvedManagedChannel> {
  const parsed = parseTelegramMessageLink(rawLink);
  const chat = await api.getChat(parsed.chatReference);
  if (chat.type !== "channel") {
    throw new Error("链接目标不是 Telegram 频道");
  }

  const member = await api.getChatMember(chat.id, botId);
  if (member.status !== "creator" && member.status !== "administrator") {
    throw new Error("Bot 不是该频道的管理员");
  }
  if (
    requirePostingPermission &&
    member.status === "administrator" &&
    member.can_post_messages !== true
  ) {
    throw new Error("Bot 在目标频道中没有发布消息权限");
  }
  if (
    requireEditingPermission &&
    member.status === "administrator" &&
    member.can_edit_messages !== true
  ) {
    throw new Error("Bot 在目标频道中没有编辑消息权限");
  }

  const username = chat.username ?? null;
  return {
    chatId: chat.id,
    title: chat.title,
    username,
    linkKind: username ? "public" : "private",
    linkChannel: username ?? canonicalPrivateLinkChannel(chat.id),
    messageId: parsed.messageId,
  };
}


export function createChannelResolver(bot: Bot) {
  return (link: string, posting: boolean, editing = false) =>
    resolveManagedChannel(bot.api, bot.botInfo.id, link, posting, editing);
}
