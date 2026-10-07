const DEFAULT_TELEGRAM_MESSAGE_LENGTH_LIMIT = 4_096;

export interface LinkSubmissionEntry {
  title: string;
  articleUrl: string;
  sourceUrl: string;
}

const ENTRY_PATTERN = /^(?<title>.+?)\s*\(\s*(?<articleUrl>https?:\/\/\S+?)\s*\)\s*\|\s*原文\s*\(\s*(?<sourceUrl>https?:\/\/\S+?)\s*\)$/u;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface FormattedLinkMessage {
  html: string;
  chunks: string[];
  count: number;
  articleUrl: string;
}

// Keep commentary as plain text; only fixed-format lines become links.
export function formatLinkSubmissionMessage(
  input: string,
  maxLength = DEFAULT_TELEGRAM_MESSAGE_LENGTH_LIMIT,
): FormattedLinkMessage | null {
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
    throw new Error("maxLength must be a positive integer");
  }
  let count = 0;
  let articleUrl = "";
  const lines = input.split(/\r?\n/).map((rawLine) => {
    if (!/\|\s*原文\s*\(/u.test(rawLine)) return escapeHtml(rawLine);
    const line = rawLine.replace(/(https?)\\:\/\//gu, "$1://");
    const entry = parseLinkSubmissionInput(line)[0]!;
    count += 1;
    articleUrl ||= entry.articleUrl;

    // A hashtag followed by whitespace provides an explicit commentary boundary.
    const prefix = /^(.*#[\p{L}\p{N}_]+)[\t ]+(\S.*)$/u.exec(entry.title);
    if (prefix) {
      entry.title = prefix[2]!;
      return `${escapeHtml(prefix[1]!)}\n${formatEntry(entry)}`;
    }
    return formatEntry(entry);
  });
  if (!count) return null;

  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (line.length > maxLength) throw new Error("单行转换后超过 Telegram 消息长度限制");
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return { html: lines.join("\n"), chunks, count, articleUrl };
}

function validateUrl(value: string, lineNumber: number, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return value;
  } catch {
    throw new Error(`第 ${lineNumber} 行${label}链接无效：${value}`);
  }
}

export function parseLinkSubmissionInput(input: string): LinkSubmissionEntry[] {
  const entries: LinkSubmissionEntry[] = [];

  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = ENTRY_PATTERN.exec(line);
    if (!match?.groups) {
      throw new Error(
        `第 ${index + 1} 行格式错误。格式：标题 (文章链接) | 原文 (原文链接)`,
      );
    }

    const title = match.groups.title?.trim() ?? "";
    const articleUrl = match.groups.articleUrl?.trim() ?? "";
    const sourceUrl = match.groups.sourceUrl?.trim() ?? "";
    if (!title || !articleUrl || !sourceUrl) {
      throw new Error(
        `第 ${index + 1} 行格式错误。格式：标题 (文章链接) | 原文 (原文链接)`,
      );
    }

    entries.push({
      title,
      articleUrl: validateUrl(articleUrl, index + 1, "文章"),
      sourceUrl: validateUrl(sourceUrl, index + 1, "原文"),
    });
  }

  if (!entries.length) {
    throw new Error("未找到可发布的链接。请按固定格式输入。");
  }
  return entries;
}

function formatEntry(entry: LinkSubmissionEntry): string {
  return [
    `<a href="${escapeHtml(entry.articleUrl)}">${escapeHtml(entry.title)}</a>`,
    `<a href="${escapeHtml(entry.sourceUrl)}">原文</a>`,
  ].join(" | ");
}

export function formatLinkSubmissionChunks(
  entries: LinkSubmissionEntry[],
  maxLength = DEFAULT_TELEGRAM_MESSAGE_LENGTH_LIMIT,
): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
    throw new Error("maxLength must be a positive integer");
  }

  const chunks: string[] = [];
  let currentChunk = "";
  for (const [index, entry] of entries.entries()) {
    const line = formatEntry(entry);
    if (line.length > maxLength) {
      throw new Error(`第 ${index + 1} 个链接转换后超过 Telegram 消息长度限制`);
    }

    const nextChunk = currentChunk ? `${currentChunk}\n${line}` : line;
    if (nextChunk.length > maxLength) {
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk = nextChunk;
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}
