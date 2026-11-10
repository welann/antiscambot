import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { deleteWithNotice } from "../message-handling.js";
import { collectMessageScanCandidates, findMatchedKeywordInCandidates, findBotTripletMatch, describeMatchSource, buildMessagePreview, truncateForNotice } from "./rules.js";

export async function moderateGroupMessage(
  ctx: Context, message: Message, botId: number,
  findKeyword: (text: string) => string | null, edited = false,
): Promise<void> {
  if (ctx.from?.id === botId) return;
  if (message.chat.type !== "group" && message.chat.type !== "supergroup") return;

  const isCommand =
    typeof message.text === "string" &&
    !!message.entities?.some((e) => e.type === "bot_command" && e.offset === 0);
  if (isCommand) return;

  const candidates = collectMessageScanCandidates(message, ctx.from?.username);
  if (!candidates.length) return;

  const match = findBotTripletMatch(message) ?? findMatchedKeywordInCandidates(candidates, findKeyword);
  if (!match) return;
  const matchReason = "keyword" in match
    ? `命中关键字：${match.keyword}`
    : "命中格式规则：@Bot用户名 + 两段内容（共三段）";

  const offender = ctx.from?.username
    ? `@${ctx.from.username}`
    : ctx.from?.id
      ? `user:${ctx.from.id}`
      : "unknown";

  const preview = buildMessagePreview(message);

  const successLines = [
    `已删除一条消息（${edited ? "编辑后" : ""}${matchReason}）`,
    `发送者：${offender}`,
    `命中位置：${describeMatchSource(match.source)}`,
    `命中内容：${truncateForNotice(match.value, 120)}`,
  ];
  if (preview && preview !== match.value) {
    successLines.push(`消息预览：${truncateForNotice(preview, 120)}`);
  }

  await deleteWithNotice(ctx.api, message, successLines.join("\n"), (reason) => {
    const failureLines = [
      `检测到${edited ? "编辑后的消息" : "消息"}${matchReason}，但删除失败。`,
      "请确认机器人在群里拥有“删除消息”的管理员权限。",
      `发送者：${offender}`,
      `命中位置：${describeMatchSource(match.source)}`,
      `命中内容：${truncateForNotice(match.value, 120)}`,
      `错误：${reason}`,
    ];
    if (preview && preview !== match.value) {
      failureLines.splice(5, 0, `消息预览：${truncateForNotice(preview, 120)}`);
    }

    return failureLines.join("\n");
  });
}
