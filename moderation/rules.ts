type MessageMatchSource = "text" | "caption" | "button_text" | "button_url" | "username";

type ScanCandidate = { source: MessageMatchSource; value: string };

type InlineKeyboardButtonLike = {
  text: string;
  url?: string;
  web_app?: { url?: string };
  login_url?: { url?: string };
};

function decodeUnicodeEscapes(str: string): string {
  // 解码 Unicode 转义序列 (\uXXXX 或 \u{XXXXXX})
  // 如果字符串已经解码，则直接返回
  if (!str.includes("\\u")) return str;

  try {
    // 将字符串包装成 JSON 字符串格式进行解析
    return JSON.parse(`"${str.replace(/"/g, '\\"')}"`);
  } catch {
    return str;
  }
}

export function collectMessageScanCandidates(message: {
  text?: string;
  caption?: string;
  reply_markup?: { inline_keyboard?: InlineKeyboardButtonLike[][] };
}, senderUsername?: string): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];

  const normalizedUsername =
    typeof senderUsername === "string" ? senderUsername.trim() : "";
  if (normalizedUsername) {
    candidates.push({ source: "username", value: normalizedUsername });
    candidates.push({ source: "username", value: `@${normalizedUsername}` });
  }

  if (typeof message.text === "string" && message.text.trim()) {
    candidates.push({ source: "text", value: message.text });
  }

  if (typeof message.caption === "string" && message.caption.trim()) {
    candidates.push({ source: "caption", value: message.caption });
  }

  const keyboard = message.reply_markup?.inline_keyboard;
  if (Array.isArray(keyboard)) {
    for (const row of keyboard) {
      if (!Array.isArray(row)) continue;

      for (const button of row) {
        if (!button || typeof button.text !== "string") continue;

        // 解码 Unicode 转义序列后再进行匹配
        const buttonText = decodeUnicodeEscapes(button.text).trim();
        if (buttonText) {
          candidates.push({ source: "button_text", value: buttonText });
        }

        const buttonUrl = button.url ?? button.web_app?.url ?? button.login_url?.url;
        if (typeof buttonUrl === "string" && buttonUrl.trim()) {
          candidates.push({ source: "button_url", value: buttonUrl.trim() });
        }
      }
    }
  }

  return candidates;
}

export function findMatchedKeywordInCandidates(
  candidates: ScanCandidate[],
  findMatchedKeyword: (text: string) => string | null,
): { keyword: string; source: MessageMatchSource; value: string } | null {
  for (const candidate of candidates) {
    const matched = findMatchedKeyword(candidate.value);
    if (matched) {
      return { keyword: matched, source: candidate.source, value: candidate.value };
    }
  }

  return null;
}

export function describeMatchSource(source: MessageMatchSource): string {
  switch (source) {
    case "text":
      return "消息文本";
    case "caption":
      return "媒体说明";
    case "button_text":
      return "按钮文字";
    case "button_url":
      return "按钮链接";
    case "username":
      return "发送者用户名";
  }
}

export function buildMessagePreview(message: {
  text?: string;
  caption?: string;
  reply_markup?: { inline_keyboard?: InlineKeyboardButtonLike[][] };
}): string {
  if (typeof message.text === "string" && message.text.trim()) return message.text;
  if (typeof message.caption === "string" && message.caption.trim()) return message.caption;

  const keyboard = message.reply_markup?.inline_keyboard;
  if (!Array.isArray(keyboard)) return "";

  const entries: string[] = [];
  for (const row of keyboard) {
    if (!Array.isArray(row)) continue;

    for (const button of row) {
      if (!button || typeof button.text !== "string") continue;

      const url = button.url ?? button.web_app?.url ?? button.login_url?.url;
      if (typeof url === "string" && url.trim()) {
        entries.push(`${button.text} -> ${url.trim()}`);
      } else {
        entries.push(button.text);
      }
    }
  }

  return entries.join(" | ");
}

export function truncateForNotice(text: string, maxLen: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return compact.slice(0, maxLen) + "…";
}


export function findBotTripletMatch(
  message: { text?: string; caption?: string },
): { source: "text" | "caption"; value: string } | null {
  for (const source of ["text", "caption"] as const) {
    const value = message[source];
    if (typeof value !== "string") continue;
    const parts = value.trim().split(/\s+/u);
    if (parts.length === 3 && /^@[a-z0-9_]+bot$/i.test(parts[0]!)) {
      return { source, value };
    }
  }
  return null;
}
