import "dotenv/config";
import { Bot, Context } from "grammy";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
if (!BOT_TOKEN) {
  throw new Error(
    "Missing BOT_TOKEN env var. Set BOT_TOKEN or hardcode your token in bot.ts.",
  );
}

const KEYWORDS_FILE = process.env.KEYWORDS_FILE ?? "./keywords.txt";
const ADMINS_FILE = process.env.ADMINS_FILE ?? "./admins.txt";

type ReleaseNote = { version: string; summary: string };

type KeywordEntry = { canonical: string; raw: string };

const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "2026-02-05",
    summary: "新增 edited_message 检测：编辑后命中关键字也会删除",
  },
  {
    version: "2026-02-01",
    summary: "新增 inline keyboard 按钮文字/链接关键字检测",
  },
  {
    version: "2026-01-28",
    summary: "首次运行可用 /start 初始化全局管理员（admins.txt）",
  },
  {
    version: "2026-01-27",
    summary: "关键词管理（keywords.txt）+ 群消息命中删除提示",
  },
];

const LOGIC_VERSION = RELEASE_NOTES[0]?.version ?? "unknown";

function formatReleaseNotesForStart(maxItems = 10): string[] {
  if (!RELEASE_NOTES.length) return [];

  return [
    "更新记录：",
    ...RELEASE_NOTES.slice(0, maxItems).map((note) => `- ${note.version}: ${note.summary}`),
  ];
}

const keywordMap = new Map<string, string>(); // canonical -> raw
let keywordEntries: KeywordEntry[] = [];

const persistedAdminIds = new Set<number>();

let keywordFileQueue: Promise<unknown> = Promise.resolve();
let adminFileQueue: Promise<unknown> = Promise.resolve();

function queueKeywordFileOp<T>(op: () => Promise<T>): Promise<T> {
  const next = keywordFileQueue.then(op, op);
  keywordFileQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function queueAdminFileOp<T>(op: () => Promise<T>): Promise<T> {
  const next = adminFileQueue.then(op, op);
  adminFileQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function normalizeKeyword(keyword: string): string {
  return keyword.trim();
}

function canonicalizeKeyword(keyword: string): string {
  return normalizeKeyword(keyword).toLowerCase();
}

function rebuildKeywordEntries(): void {
  keywordEntries = Array.from(keywordMap.entries()).map(([canonical, raw]) => ({
    canonical,
    raw,
  }));
  keywordEntries.sort((a, b) => b.canonical.length - a.canonical.length);
}

async function ensureKeywordsFile(): Promise<void> {
  try {
    await readFile(KEYWORDS_FILE, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;

    await mkdir(dirname(KEYWORDS_FILE), { recursive: true });
    await writeFile(KEYWORDS_FILE, "", "utf8");
  }
}

async function loadKeywordsFromDisk(): Promise<void> {
  await ensureKeywordsFile();

  const contents = await readFile(KEYWORDS_FILE, "utf8");
  keywordMap.clear();

  for (const line of contents.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;

    const canonical = canonicalizeKeyword(raw);
    if (keywordMap.has(canonical)) continue;
    keywordMap.set(canonical, raw);
  }

  rebuildKeywordEntries();
}

async function ensureAdminsFile(): Promise<void> {
  try {
    await readFile(ADMINS_FILE, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;

    await mkdir(dirname(ADMINS_FILE), { recursive: true });
    await writeFile(ADMINS_FILE, "", "utf8");
  }
}

async function loadAdminsFromDisk(): Promise<void> {
  await ensureAdminsFile();

  const contents = await readFile(ADMINS_FILE, "utf8");
  persistedAdminIds.clear();

  for (const line of contents.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;

    const userId = Number(raw);
    if (!Number.isInteger(userId) || userId <= 0) continue;

    persistedAdminIds.add(userId);
  }
}

async function addKeywordFromUserInput(
  input: string,
): Promise<{ added: boolean; keyword?: string | undefined; reason?: "empty" | "exists" }> {
  const raw = normalizeKeyword(input);
  if (!raw) return { added: false, reason: "empty" };

  const canonical = canonicalizeKeyword(raw);

  return queueKeywordFileOp(async () => {
    if (keywordMap.has(canonical)) {
      return { added: false, reason: "exists", keyword: keywordMap.get(canonical) };
    }

    await ensureKeywordsFile();
    await appendFile(KEYWORDS_FILE, raw + "\n", "utf8");

    keywordMap.set(canonical, raw);
    rebuildKeywordEntries();

    return { added: true, keyword: raw };
  });
}

async function removeKeywordFromUserInput(
  input: string,
): Promise<{ removed: boolean; keyword?: string; reason?: "empty" | "missing" }> {
  const raw = normalizeKeyword(input);
  if (!raw) return { removed: false, reason: "empty" };

  const canonical = canonicalizeKeyword(raw);

  return queueKeywordFileOp(async () => {
    const existed = keywordMap.get(canonical);
    if (!existed) return { removed: false, reason: "missing" };

    keywordMap.delete(canonical);
    rebuildKeywordEntries();

    const lines = Array.from(keywordMap.values());
    const nextContents = lines.join("\n") + (lines.length ? "\n" : "");

    await ensureKeywordsFile();
    await writeFile(KEYWORDS_FILE, nextContents, "utf8");

    return { removed: true, keyword: existed };
  });
}

function getAllKeywords(): string[] {
  return Array.from(keywordMap.values());
}

function findMatchedKeyword(text: string): string | null {
  if (!keywordEntries.length) return null;

  const haystack = text.toLowerCase();
  for (const { canonical, raw } of keywordEntries) {
    if (canonical && haystack.includes(canonical)) return raw;
  }

  return null;
}

type MessageMatchSource = "text" | "caption" | "button_text" | "button_url";

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

function collectMessageScanCandidates(message: {
  text?: string;
  caption?: string;
  reply_markup?: { inline_keyboard?: InlineKeyboardButtonLike[][] };
}): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];

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

function findMatchedKeywordInCandidates(
  candidates: ScanCandidate[],
): { keyword: string; source: MessageMatchSource; value: string } | null {
  for (const candidate of candidates) {
    const matched = findMatchedKeyword(candidate.value);
    if (matched) {
      return { keyword: matched, source: candidate.source, value: candidate.value };
    }
  }

  return null;
}

function describeMatchSource(source: MessageMatchSource): string {
  switch (source) {
    case "text":
      return "消息文本";
    case "caption":
      return "媒体说明";
    case "button_text":
      return "按钮文字";
    case "button_url":
      return "按钮链接";
  }
}

function buildMessagePreview(message: {
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

function truncateForNotice(text: string, maxLen: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return compact.slice(0, maxLen) + "…";
}

const KEYWORD_ADMIN_IDS = new Set<number>(
  (process.env.KEYWORD_ADMIN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0),
);

function isGlobalKeywordAdmin(userId: number): boolean {
  return KEYWORD_ADMIN_IDS.has(userId) || persistedAdminIds.has(userId);
}

async function canManageKeywords(ctx: Context): Promise<boolean> {
  if (!ctx.from) return false;
  if (isGlobalKeywordAdmin(ctx.from.id)) return true;

  if (!ctx.chat) return false;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return false;

  try {
    const admins = await ctx.api.getChatAdministrators(ctx.chat.id);
    return admins.some((m) => m.user.id === ctx.from!.id);
  } catch {
    return false;
  }
}

function hasAnyGlobalAdmins(): boolean {
  return KEYWORD_ADMIN_IDS.size > 0 || persistedAdminIds.size > 0;
}

async function bootstrapFirstAdminIfNeeded(userId: number): Promise<boolean> {
  if (hasAnyGlobalAdmins()) return false;

  return queueAdminFileOp(async () => {
    if (hasAnyGlobalAdmins()) return false;

    await ensureAdminsFile();
    await appendFile(ADMINS_FILE, String(userId) + "\n", "utf8");
    persistedAdminIds.add(userId);

    return true;
  });
}

const bot = new Bot(BOT_TOKEN);
let BOT_ID: number | null = null;

bot.command("start", async (ctx) => {
  const becameAdmin = ctx.from
    ? await bootstrapFirstAdminIfNeeded(ctx.from.id)
    : false;

  const lines: string[] = [];

  if (becameAdmin) {
    lines.push(
      "已初始化管理员：你是第一个使用 /start 的用户，已记录为全局管理员。",
      "",
    );
  }

  lines.push("Anti-scam bot is running.", `版本：${LOGIC_VERSION}`);

  const releaseNotes = formatReleaseNotesForStart();
  if (releaseNotes.length) {
    lines.push("", ...releaseNotes);
  }

  lines.push(
    "",
    "Commands:",
    "- /addkw <keyword>  添加待检测关键字 (管理员)",
    "- /delkw <keyword>  删除关键字 (管理员)",
    "- /keywords         查看所有关键字",
  );

  return ctx.reply(lines.join("\n"));
});

bot.command("addkw", async (ctx) => {
  if (!(await canManageKeywords(ctx))) {
    return ctx.reply(
      "无权限：仅群管理员可操作（或设置 KEYWORD_ADMIN_IDS=123,456；首次运行可用 /start 初始化全局管理员）。",
    );
  }

  const keyword = ctx.match?.trim() ?? "";
  const result = await addKeywordFromUserInput(keyword);

  if (!result.added) {
    if (result.reason === "empty") return ctx.reply("用法：/addkw <keyword>");
    if (result.reason === "exists") {
      return ctx.reply(`关键字已存在：${result.keyword}`);
    }
    return ctx.reply("添加失败。");
  }

  return ctx.reply(`已添加关键字：${result.keyword}`);
});

bot.command("delkw", async (ctx) => {
  if (!(await canManageKeywords(ctx))) {
    return ctx.reply(
      "无权限：仅群管理员可操作（或设置 KEYWORD_ADMIN_IDS=123,456；首次运行可用 /start 初始化全局管理员）。",
    );
  }

  const keyword = ctx.match?.trim() ?? "";
  const result = await removeKeywordFromUserInput(keyword);

  if (!result.removed) {
    if (result.reason === "empty") return ctx.reply("用法：/delkw <keyword>");
    if (result.reason === "missing") return ctx.reply("关键字不存在。");
    return ctx.reply("删除失败。");
  }

  return ctx.reply(`已删除关键字：${result.keyword}`);
});

bot.command("keywords", (ctx) => {
  const keywords = getAllKeywords();
  if (!keywords.length) return ctx.reply("当前没有任何待检测关键字。");

  return ctx.reply(["当前待检测关键字：", ...keywords.map((k) => `- ${k}`)].join("\n"));
});

bot.on("message", async (ctx) => {
  if (BOT_ID !== null && ctx.from?.id === BOT_ID) return;
  if (!ctx.chat || !ctx.message) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

  const isCommand =
    typeof ctx.message.text === "string" &&
    !!ctx.message.entities?.some((e) => e.type === "bot_command" && e.offset === 0);
  if (isCommand) return;

  const candidates = collectMessageScanCandidates(ctx.message);
  if (!candidates.length) return;

  const match = findMatchedKeywordInCandidates(candidates);
  if (!match) return;

  const offender = ctx.from?.username
    ? `@${ctx.from.username}`
    : ctx.from?.id
      ? `user:${ctx.from.id}`
      : "unknown";

  const preview = buildMessagePreview(ctx.message);

  const successLines = [
    `已删除一条消息（命中关键字：${match.keyword}）`,
    `发送者：${offender}`,
    `命中位置：${describeMatchSource(match.source)}`,
    `命中内容：${truncateForNotice(match.value, 120)}`,
  ];
  if (preview && preview !== match.value) {
    successLines.push(`消息预览：${truncateForNotice(preview, 120)}`);
  }

  try {
    await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    await ctx.api.sendMessage(ctx.chat.id, successLines.join("\n"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    const failureLines = [
      `检测到关键字命中（${match.keyword}），但删除失败。`,
      "请确认机器人在群里拥有“删除消息”的管理员权限。",
      `发送者：${offender}`,
      `命中位置：${describeMatchSource(match.source)}`,
      `命中内容：${truncateForNotice(match.value, 120)}`,
      `错误：${reason}`,
    ];
    if (preview && preview !== match.value) {
      failureLines.splice(5, 0, `消息预览：${truncateForNotice(preview, 120)}`);
    }

    await ctx.api.sendMessage(ctx.chat.id, failureLines.join("\n"));
  }
});

bot.on("edited_message", async (ctx) => {
  if (BOT_ID !== null && ctx.from?.id === BOT_ID) return;
  if (!ctx.chat || !ctx.editedMessage) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

  const isCommand =
    typeof ctx.editedMessage.text === "string" &&
    !!ctx.editedMessage.entities?.some((e) => e.type === "bot_command" && e.offset === 0);
  if (isCommand) return;

  const candidates = collectMessageScanCandidates(ctx.editedMessage);
  if (!candidates.length) return;

  const match = findMatchedKeywordInCandidates(candidates);
  if (!match) return;

  const offender = ctx.from?.username
    ? `@${ctx.from.username}`
    : ctx.from?.id
      ? `user:${ctx.from.id}`
      : "unknown";

  const preview = buildMessagePreview(ctx.editedMessage);

  const successLines = [
    `已删除一条消息（编辑后命中关键字：${match.keyword}）`,
    `发送者：${offender}`,
    `命中位置：${describeMatchSource(match.source)}`,
    `命中内容：${truncateForNotice(match.value, 120)}`,
  ];
  if (preview && preview !== match.value) {
    successLines.push(`消息预览：${truncateForNotice(preview, 120)}`);
  }

  try {
    await ctx.api.deleteMessage(ctx.chat.id, ctx.editedMessage.message_id);
    await ctx.api.sendMessage(ctx.chat.id, successLines.join("\n"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    const failureLines = [
      `检测到编辑后的消息命中关键字（${match.keyword}），但删除失败。`,
      "请确认机器人在群里拥有“删除消息”的管理员权限。",
      `发送者：${offender}`,
      `命中位置：${describeMatchSource(match.source)}`,
      `命中内容：${truncateForNotice(match.value, 120)}`,
      `错误：${reason}`,
    ];
    if (preview && preview !== match.value) {
      failureLines.splice(5, 0, `消息预览：${truncateForNotice(preview, 120)}`);
    }

    await ctx.api.sendMessage(ctx.chat.id, failureLines.join("\n"));
  }
});

async function main(): Promise<void> {
  await loadKeywordsFromDisk();
  await loadAdminsFromDisk();
  const me = await bot.api.getMe();
  BOT_ID = me.id;
  bot.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
