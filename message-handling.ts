import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { formatLinkSubmissionMessage } from "./link-submission.js";

export async function convertChannelLinks(
  api: Pick<Api, "getChatMember" | "editMessageText" | "editMessageCaption">,
  message: Message,
  botId: number,
): Promise<boolean> {
  if (message.chat.type !== "channel") return false;
  const text = message.text ?? message.caption;
  const entities = message.entities ?? message.caption_entities;
  if (!text || entities?.some((entity) => entity.type === "bot_command" && entity.offset === 0)) {
    return false;
  }
  const formatted = formatLinkSubmissionMessage(text, message.text !== undefined ? 4096 : 1024);
  if (!formatted) return false;
  if (formatted.chunks.length !== 1) throw new Error("转换后超过单条消息长度限制，已保留原消息");

  const member = await api.getChatMember(message.chat.id, botId);
  if (member.status !== "creator" &&
    !(member.status === "administrator" && member.can_edit_messages)) return false;

  const markup = message.reply_markup ? { reply_markup: message.reply_markup } : {};
  if (message.text !== undefined) {
    await api.editMessageText(message.chat.id, message.message_id, formatted.html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: false, url: formatted.articleUrl },
      ...markup,
    });
  } else {
    await api.editMessageCaption(message.chat.id, message.message_id, {
      caption: formatted.html,
      parse_mode: "HTML",
      ...markup,
    });
  }
  return true;
}

export function replyLocation(message: Message, replyToSelf = false) {
  const messageId = replyToSelf ? message.message_id : message.reply_to_message?.message_id;
  return {
    ...(message.is_topic_message && message.message_thread_id !== undefined
      ? { message_thread_id: message.message_thread_id }
      : {}),
    ...(messageId !== undefined
      ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } }
      : {}),
  };
}

export async function deleteWithNotice(
  api: Pick<Api, "deleteMessage" | "sendMessage">,
  message: Message,
  successText: string,
  failureText: (reason: string) => string,
): Promise<void> {
  let notice = successText;
  let deleted = false;
  try {
    await api.deleteMessage(message.chat.id, message.message_id);
    deleted = true;
  } catch (error) {
    notice = failureText(error instanceof Error ? error.message : String(error));
  }
  // A notice failure must not be reported as a deletion failure.
  if (!deleted) {
    await api.sendMessage(message.chat.id, notice, replyLocation(message, true));
    return;
  }

  const location = replyLocation(message);
  const { reply_parameters, ...standaloneLocation } = location;
  try {
    await api.sendMessage(message.chat.id, notice, {
      ...standaloneLocation,
      link_preview_options: { is_disabled: true },
    });
  } finally {
    // Keep the short thread notice even if sending the detailed record fails.
    if (reply_parameters || location.message_thread_id !== undefined) {
      await api.sendMessage(message.chat.id, "已删除一条消息", location);
    }
  }
}
