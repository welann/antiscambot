import "dotenv/config";
import { Bot, Context } from "grammy";
import { schedule, validate } from "node-cron";
import type { ScheduledTask } from "node-cron";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DigestRepository,
  DigestService,
  getLocalDate,
  parseTelegramMessageLink,
  shouldRunDailyCatchUp,
} from "./digest.js";
import type {
  LinkKind,
  SourceChannelInput,
  TargetChannelInput,
} from "./digest.js";

const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
if (!BOT_TOKEN) {
  throw new Error(
    "Missing BOT_TOKEN env var. Set BOT_TOKEN or hardcode your token in bot.ts.",
  );
}

const KEYWORDS_FILE = process.env.KEYWORDS_FILE ?? "./keywords.txt";
const ADMINS_FILE = process.env.ADMINS_FILE ?? "./admins.txt";
const DIGEST_DB_FILE =
  process.env.DIGEST_DB_FILE ?? "./data/antiscambot.sqlite";
const DIGEST_CRON = process.env.DIGEST_CRON ?? "0 12 * * *";
const DIGEST_TIMEZONE = process.env.DIGEST_TIMEZONE ?? "Asia/Shanghai";
const DIGEST_SAMPLE_SIZE = parsePositiveInteger(
  process.env.DIGEST_SAMPLE_SIZE,
  10,
  "DIGEST_SAMPLE_SIZE",
);

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100) {
    throw new Error(`${name} must be an integer between 1 and 100`);
  }
  return value;
}

type ReleaseNote = { version: string; summary: string };

type KeywordEntry = { canonical: string; raw: string };

const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "2026-07-23",
    summary: "新增多频道历史随机链接汇总与 SQLite 持久化",
  },
  {
    version: "2026-02-28",
    summary: "新增发送者用户名关键字检测",
  },
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
    "RELEASE_NOTES:",
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

function collectMessageScanCandidates(message: {
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
    case "username":
      return "发送者用户名";
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
let digestRepository: DigestRepository | null = null;
let digestService: DigestService | null = null;
let digestTask: ScheduledTask | null = null;

function getDigestRepository(): DigestRepository {
  if (!digestRepository) throw new Error("摘要数据库尚未初始化");
  return digestRepository;
}

function getDigestService(): DigestService {
  if (!digestService) throw new Error("摘要服务尚未初始化");
  return digestService;
}

function canManageDigest(ctx: Context): boolean {
  return (
    ctx.chat?.type === "private" &&
    !!ctx.from &&
    isGlobalKeywordAdmin(ctx.from.id)
  );
}

async function rejectUnauthorizedDigestCommand(ctx: Context): Promise<boolean> {
  if (canManageDigest(ctx)) return false;
  await ctx.reply("无权限：频道摘要配置只能由全局管理员在 Bot 私聊中操作。");
  return true;
}

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

async function resolveManagedChannel(
  rawLink: string,
  requirePostingPermission: boolean,
): Promise<ResolvedManagedChannel> {
  if (BOT_ID === null) throw new Error("Bot 信息尚未初始化");

  const parsed = parseTelegramMessageLink(rawLink);
  const chat = await bot.api.getChat(parsed.chatReference);
  if (chat.type !== "channel") {
    throw new Error("链接目标不是 Telegram 频道");
  }

  const member = await bot.api.getChatMember(chat.id, BOT_ID);
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

function formatDigestRunResult(
  result: Awaited<ReturnType<DigestService["run"]>>,
): string {
  switch (result.status) {
    case "sent":
      return `汇总发送完成：${result.itemCount} 个链接，${result.messageCount} 条目标消息。`;
    case "empty":
      return "没有可用的新序号：所有来源均已耗尽。";
    case "busy":
      return "已有摘要任务正在运行，请稍后重试。";
    case "already-ran":
      return "今天的自动汇总已经执行过。";
    case "not-configured":
      return `摘要配置不完整：${result.error ?? "未知原因"}`;
    case "failed":
      return `摘要发送失败：${result.error ?? "未知错误"}。已预留的序号不会再次抽取。`;
  }
}

async function runScheduledDigest(): Promise<void> {
  const service = getDigestService();
  const localDate = getLocalDate(new Date(), DIGEST_TIMEZONE);
  const result = await service.run("scheduled", localDate);
  if (result.status === "failed" || result.status === "not-configured") {
    console.error(`[digest] ${formatDigestRunResult(result)}`);
  } else {
    console.log(`[digest] ${formatDigestRunResult(result)}`);
  }
}

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
    "- /addsource <links> 添加摘要来源频道 (全局管理员私聊)",
    "- /sources           查看摘要来源与目标",
    "- /delsource <编号>  停用摘要来源",
    "- /settarget <link>  设置摘要目标频道",
    "- /digestnow         立即发送一次摘要",
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

bot.command("addsource", async (ctx) => {
  if (await rejectUnauthorizedDigestCommand(ctx)) return;

  const links = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
  if (!links.length) {
    return ctx.reply(
      "用法：/addsource <来源频道最新帖子链接>\n可用空格或换行一次提交多个链接。",
    );
  }

  const repository = getDigestRepository();
  const target = repository.getTarget();
  const resultLines: string[] = [];

  for (const link of links) {
    try {
      const channel = await resolveManagedChannel(link, false);
      if (target?.chatId === channel.chatId) {
        throw new Error("该频道当前是摘要目标频道，不能同时作为来源");
      }

      const source: SourceChannelInput = {
        chatId: channel.chatId,
        title: channel.title,
        username: channel.username,
        linkKind: channel.linkKind,
        linkChannel: channel.linkChannel,
        latestMessageId: channel.messageId,
      };
      const saved = repository.upsertSource(source);
      resultLines.push(
        `✅ ${saved.title}：最新消息 ID ${saved.latestMessageId}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      resultLines.push(`❌ ${link}：${reason}`);
    }
  }

  return ctx.reply(resultLines.join("\n"), {
    link_preview_options: { is_disabled: true },
  });
});

bot.command("sources", async (ctx) => {
  if (await rejectUnauthorizedDigestCommand(ctx)) return;

  const repository = getDigestRepository();
  const target = repository.getTarget();
  const sources = repository.listActiveSourceStats();
  const lines = [
    "频道摘要配置",
    target
      ? `目标：${target.title} (${target.chatId})`
      : "目标：尚未设置",
    "",
    `来源频道：${sources.length} 个`,
  ];

  if (!sources.length) {
    lines.push("- 尚未添加来源频道");
  } else {
    for (const [index, source] of sources.entries()) {
      lines.push(
        `${index + 1}. ${source.title}`,
        `   最新 ID: ${source.latestMessageId}｜已用: ${source.usedCount}｜剩余: ${source.remainingCount}`,
      );
    }
  }

  return ctx.reply(lines.join("\n"));
});

bot.command("delsource", async (ctx) => {
  if (await rejectUnauthorizedDigestCommand(ctx)) return;

  const index = Number(ctx.match?.trim() ?? "");
  if (!Number.isSafeInteger(index) || index <= 0) {
    return ctx.reply("用法：/delsource <来源编号>\n来源编号可通过 /sources 查看。");
  }

  const source = getDigestRepository().deactivateSourceByIndex(index);
  if (!source) return ctx.reply("来源编号不存在，请先使用 /sources 查看。");
  return ctx.reply(
    `已停用来源频道：${source.title}\n历史抽取记录仍保留，重新添加后不会重复。`,
  );
});

bot.command("settarget", async (ctx) => {
  if (await rejectUnauthorizedDigestCommand(ctx)) return;

  const links = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
  if (links.length !== 1) {
    return ctx.reply("用法：/settarget <目标频道任意帖子链接>");
  }

  try {
    const link = links[0];
    if (!link) return ctx.reply("用法：/settarget <目标频道任意帖子链接>");
    const channel = await resolveManagedChannel(link, true);
    const repository = getDigestRepository();
    const existingSource = repository.getSource(channel.chatId);
    if (existingSource?.active) {
      throw new Error("该频道当前是摘要来源频道，不能同时作为目标");
    }

    const target: TargetChannelInput = {
      chatId: channel.chatId,
      title: channel.title,
      username: channel.username,
      linkKind: channel.linkKind,
      linkChannel: channel.linkChannel,
    };
    const saved = repository.setTarget(target);
    return ctx.reply(`已设置摘要目标频道：${saved.title} (${saved.chatId})`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return ctx.reply(`设置目标频道失败：${reason}`);
  }
});

bot.command("digestnow", async (ctx) => {
  if (await rejectUnauthorizedDigestCommand(ctx)) return;

  const result = await getDigestService().run(
    "manual",
    getLocalDate(new Date(), DIGEST_TIMEZONE),
  );
  return ctx.reply(formatDigestRunResult(result));
});

bot.on("message", async (ctx) => {
  if (BOT_ID !== null && ctx.from?.id === BOT_ID) return;
  if (!ctx.chat || !ctx.message) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

  const isCommand =
    typeof ctx.message.text === "string" &&
    !!ctx.message.entities?.some((e) => e.type === "bot_command" && e.offset === 0);
  if (isCommand) return;

  const candidates = collectMessageScanCandidates(ctx.message, ctx.from?.username);
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

  const candidates = collectMessageScanCandidates(ctx.editedMessage, ctx.from?.username);
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

bot.on("channel_post", (ctx) => {
  const repository = digestRepository;
  if (!repository) return;

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

async function main(): Promise<void> {
  await loadKeywordsFromDisk();
  await loadAdminsFromDisk();
  const me = await bot.api.getMe();
  BOT_ID = me.id;

  if (!validate(DIGEST_CRON)) {
    throw new Error(`DIGEST_CRON is invalid: ${DIGEST_CRON}`);
  }
  // Validate the timezone eagerly instead of failing inside the cron callback.
  getLocalDate(new Date(), DIGEST_TIMEZONE);

  digestRepository = new DigestRepository(DIGEST_DB_FILE, {
    cronExpression: DIGEST_CRON,
    timeZone: DIGEST_TIMEZONE,
    sampleSize: DIGEST_SAMPLE_SIZE,
  });
  digestService = new DigestService(
    digestRepository,
    async (targetChatId, html) => {
      const message = await bot.api.sendMessage(targetChatId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return { messageId: message.message_id };
    },
    DIGEST_SAMPLE_SIZE,
  );

  digestTask = schedule(
    DIGEST_CRON,
    async () => {
      await runScheduledDigest();
    },
    {
      timezone: DIGEST_TIMEZONE,
      noOverlap: true,
      name: "daily-channel-digest",
    },
  );

  const now = new Date();
  const today = getLocalDate(now, DIGEST_TIMEZONE);
  if (
    shouldRunDailyCatchUp(DIGEST_CRON, DIGEST_TIMEZONE, now) &&
    !digestRepository.hasScheduledRun(today)
  ) {
    await runScheduledDigest();
  }

  try {
    await bot.start();
  } finally {
    await digestTask.stop();
    digestRepository.close();
  }
}

bot.catch((error) => {
  console.error("Bot handler failed:", error.error);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
