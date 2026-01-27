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

type KeywordEntry = { canonical: string; raw: string };

const keywordMap = new Map<string, string>(); // canonical -> raw
let keywordEntries: KeywordEntry[] = [];

let keywordFileQueue: Promise<unknown> = Promise.resolve();

function queueKeywordFileOp<T>(op: () => Promise<T>): Promise<T> {
  const next = keywordFileQueue.then(op, op);
  keywordFileQueue = next.then(
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

async function addKeywordFromUserInput(
  input: string,
): Promise<{ added: boolean; keyword?: string; reason?: "empty" | "exists" }> {
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
  return KEYWORD_ADMIN_IDS.has(userId);
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

const bot = new Bot(BOT_TOKEN);
let BOT_ID: number | null = null;

bot.command("start", (ctx) => {
  ctx.reply(
    [
      "Anti-scam bot is running.",
      "\nCommands:",
      "- /addkw <keyword>  添加待检测关键字 (管理员)",
      "- /delkw <keyword>  删除关键字 (管理员)",
      "- /keywords         查看所有关键字",
    ].join("\n"),
  );
});

bot.command("addkw", async (ctx) => {
  if (!(await canManageKeywords(ctx))) {
    return ctx.reply(
      "无权限：仅群管理员可操作（或在私聊中设置 KEYWORD_ADMIN_IDS=123,456 作为全局管理员）。",
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
      "无权限：仅群管理员可操作（或在私聊中设置 KEYWORD_ADMIN_IDS=123,456 作为全局管理员）。",
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

  const text = ctx.message.text ?? ctx.message.caption;
  if (!text) return;

  const isCommand =
    !!ctx.message.entities?.some((e) => e.type === "bot_command" && e.offset === 0) &&
    ctx.message.text === text;
  if (isCommand) return;

  const matched = findMatchedKeyword(text);
  if (!matched) return;

  const offender = ctx.from?.username
    ? `@${ctx.from.username}`
    : ctx.from?.id
      ? `user:${ctx.from.id}`
      : "unknown";

  try {
    await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    await ctx.api.sendMessage(
      ctx.chat.id,
      [
        `已删除一条消息（命中关键字：${matched}）`,
        `发送者：${offender}`,
        `内容：${truncateForNotice(text, 120)}`,
      ].join("\n"),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await ctx.api.sendMessage(
      ctx.chat.id,
      [
        `检测到关键字命中（${matched}），但删除失败。`,
        "请确认机器人在群里拥有“删除消息”的管理员权限。",
        `发送者：${offender}`,
        `错误：${reason}`,
      ].join("\n"),
    );
  }
});

async function main(): Promise<void> {
  await loadKeywordsFromDisk();
  const me = await bot.api.getMe();
  BOT_ID = me.id;
  bot.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
