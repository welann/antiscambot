import { MAX_TELEGRAM_MESSAGE_ID } from "./types.js";

import type {
  DigestChunk,
  DigestSection,
  DigestSelection,
  ParsedTelegramMessageLink,
  SourceChannel,
} from "./types.js";

const DEFAULT_MESSAGE_LENGTH_LIMIT = 4_096;

export function parseTelegramMessageLink(
  input: string,
): ParsedTelegramMessageLink {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`无效的 Telegram 消息链接：${raw || "(空)"}`);
  }

  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (hostname !== "t.me" && hostname !== "www.t.me")) {
    throw new Error(`仅支持 https://t.me/... 消息链接：${raw}`);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "s") segments.shift();

  if (segments[0] === "c") {
    const channel = segments[1] ?? "";
    const message = segments[2] ?? "";
    if (!/^\d+$/.test(channel) || !/^\d+$/.test(message)) {
      throw new Error(`无效的私有频道消息链接：${raw}`);
    }
    const messageId = parseMessageId(message, raw);
    const chatId = Number(`-100${channel}`);
    if (!Number.isSafeInteger(chatId)) {
      throw new Error(`私有频道 ID 超出安全范围：${raw}`);
    }
    return {
      chatReference: chatId,
      linkKind: "private",
      linkChannel: channel,
      messageId,
    };
  }

  const username = segments[0] ?? "";
  const message = segments[1] ?? "";
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username) || !/^\d+$/.test(message)) {
    throw new Error(`无效的公开频道消息链接：${raw}`);
  }

  return {
    chatReference: `@${username}`,
    linkKind: "public",
    linkChannel: username,
    messageId: parseMessageId(message, raw),
  };
}

function parseMessageId(value: string, originalLink: string): number {
  const messageId = Number(value);
  if (
    !Number.isSafeInteger(messageId) ||
    messageId <= 0 ||
    messageId > MAX_TELEGRAM_MESSAGE_ID
  ) {
    throw new Error(`消息 ID 无效：${originalLink}`);
  }
  return messageId;
}

export function buildTelegramMessageLink(
  source: Pick<SourceChannel, "linkKind" | "linkChannel">,
  messageId: number,
): string {
  if (source.linkKind === "public") {
    return `https://t.me/${source.linkChannel}/${messageId}`;
  }
  return `https://t.me/c/${source.linkChannel}/${messageId}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatDigestChunks(
  sections: DigestSection[],
  localDate: string,
  messageLengthLimit = DEFAULT_MESSAGE_LENGTH_LIMIT,
): DigestChunk[] {
  const nonEmptySections = sections.filter((section) => section.selections.length > 0);
  if (!nonEmptySections.length) return [];

  const totalItems = nonEmptySections.reduce(
    (sum, section) => sum + section.selections.length,
    0,
  );
  const baseHeaderHtml =
    `<b>📚 每日频道历史随机精选</b>\n` +
    `<i>${escapeHtml(localDate)} · 共 ${totalItems} 条</i>`;
  const baseHeaderText = `📚 每日频道历史随机精选\n${localDate} · 共 ${totalItems} 条`;
  const continuationHeaderHtml =
    `<b>📚 每日频道历史随机精选（续）</b>\n` +
    `<i>${escapeHtml(localDate)} · 共 ${totalItems} 条</i>`;
  const continuationHeaderText =
    `📚 每日频道历史随机精选（续）\n${localDate} · 共 ${totalItems} 条`;

  const chunks: DigestChunk[] = [];
  let currentHtml = baseHeaderHtml;
  let currentText = baseHeaderText;
  let currentSelections: DigestSelection[] = [];

  for (const section of nonEmptySections) {
    const linesHtml = [
      `<b>📢 ${escapeHtml(section.source.title)}</b>`,
      ...section.selections.map(
        (selection, index) =>
          `${String(index + 1).padStart(2, "0")}. ` +
          `<a href="${escapeHtml(selection.messageLink)}">` +
          `消息 #${selection.sourceMessageId}</a>`,
      ),
    ];
    const linesText = [
      `📢 ${section.source.title}`,
      ...section.selections.map(
        (selection, index) =>
          `${String(index + 1).padStart(2, "0")}. 消息 #${selection.sourceMessageId}`,
      ),
    ];
    const sectionHtml = linesHtml.join("\n");
    const sectionText = linesText.join("\n");
    const candidateText = `${currentText}\n\n${sectionText}`;

    if (
      candidateText.length > messageLengthLimit &&
      currentSelections.length > 0
    ) {
      chunks.push({ html: currentHtml, selections: currentSelections });
      currentHtml = `${continuationHeaderHtml}\n\n${sectionHtml}`;
      currentText = `${continuationHeaderText}\n\n${sectionText}`;
      currentSelections = [...section.selections];
    } else {
      currentHtml = `${currentHtml}\n\n${sectionHtml}`;
      currentText = candidateText;
      currentSelections.push(...section.selections);
    }
  }

  if (currentSelections.length > 0) {
    chunks.push({ html: currentHtml, selections: currentSelections });
  }
  return chunks;
}
