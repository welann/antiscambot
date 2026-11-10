import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update, UserFromGetMe } from "grammy/types";
import { readConfig } from "../app/config.js";
import { createBot } from "../app/create-bot.js";
import { KeywordStore } from "../storage/keywords.js";
import { AdminStore } from "../storage/admins.js";
import { DigestRepository, DigestService } from "../digest.js";
import { CalendarRepository, CalendarService } from "../calendar.js";

const botInfo: UserFromGetMe = {
  id: 99, is_bot: true, first_name: "Test", username: "testbot",
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "antiscam-app-"));
  const config = readConfig({ BOT_TOKEN: "123:test", KEYWORD_ADMIN_IDS: "100" });
  const keywords = new KeywordStore(join(directory, "keywords.txt"));
  const admins = new AdminStore(join(directory, "admins.txt"), config.adminIds);
  await keywords.load();
  await admins.load();
  const digestRepository = new DigestRepository(":memory:");
  const calendarRepository = new CalendarRepository(":memory:");
  const digestService = new DigestService(digestRepository, async () => ({ messageId: 1 }), 10);
  const calendarService = new CalendarService(calendarRepository, async () => new Uint8Array(), async () => 1);
  const bot = createBot(config, { keywords, admins, digestRepository, digestService, calendarService });
  bot.botInfo = botInfo;
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (prev, method, payload) => {
    calls.push({ method, payload });
    const data = payload as Record<string, unknown>;
    let result: unknown = true;
    if (method === "getChatAdministrators") result = [];
    if (method === "getChatMember") result = { status: "administrator", user: botInfo, can_edit_messages: true };
    if (method === "sendMessage") result = { message_id: 500, date: 1, chat: { id: data.chat_id, type: "supergroup" }, text: data.text };
    return { ok: true, result } as Awaited<ReturnType<typeof prev>>;
  });
  let updateId = 0;
  async function send(text: string, options: { edited?: boolean; private?: boolean; userId?: number; caption?: boolean } = {}) {
    const content = {
      message_id: 42, date: 1,
      from: { id: options.userId ?? 200, is_bot: false, first_name: "User", username: "user" },
      chat: options.private ? { id: 200, type: "private", first_name: "User" } : { id: -123, type: "supergroup", title: "Group" },
      ...(options.caption ? { caption: text, photo: [] } : { text }),
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
      reply_to_message: { message_id: 10, date: 1, chat: { id: -123, type: "supergroup", title: "Group" } },
    };
    await bot.handleUpdate({ update_id: ++updateId, [options.edited ? "edited_message" : "message"]: content } as unknown as Update);
  }
  return { config, keywords, admins, bot, calls, send, directory,
    async close() { digestRepository.close(); calendarRepository.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("configuration is explicit, validates before startup, and preserves defaults", () => {
  assert.throws(() => readConfig({}), /BOT_TOKEN/);
  assert.throws(() => readConfig({ BOT_TOKEN: "x", DIGEST_SAMPLE_SIZE: "0" }), /DIGEST_SAMPLE_SIZE/);
  assert.throws(() => readConfig({ BOT_TOKEN: "x", DIGEST_CRON: "invalid" }), /DIGEST_CRON/);
  assert.throws(() => readConfig({ BOT_TOKEN: "x", DIGEST_TIMEZONE: "invalid" }));
  const config = readConfig({ BOT_TOKEN: "x", KEYWORD_ADMIN_IDS: "100,invalid,0,100,200" });
  assert.equal(config.digestSampleSize, 10);
  assert.equal(config.digestTimeZone, "Asia/Shanghai");
  assert.deepEqual([...config.adminIds], [100, 200]);
});

test("command routing rejects non-admin changes and persists authorized keyword commands", async () => {
  const f = await fixture();
  try {
    await f.send("/addkw spam");
    assert.deepEqual(f.keywords.list(), []);
    await f.send("/addkw spam", { userId: 100 });
    assert.deepEqual(f.keywords.list(), ["spam"]);
    await f.send("/clearkw", { userId: 100 });
    assert.deepEqual(f.keywords.list(), []);
    assert.equal(await readFile(join(f.directory, "keywords.txt"), "utf8"), "");
    assert.equal(f.calls.some((call) => call.method === "deleteMessage"), false);
  } finally { await f.close(); }
});

test("real middleware preserves independent triplet deletion for new and edited messages", async () => {
  const f = await fixture();
  try {
    for (const edited of [false, true]) {
      f.calls.length = 0;
      await f.send("@examplebot one two", { edited });
      assert.deepEqual(f.calls.map((call) => call.method), ["deleteMessage", "sendMessage", "sendMessage"]);
      assert.equal(f.calls[0]?.payload.message_id, 42);
      assert.match(String(f.calls[1]?.payload.text), /命中格式规则/);
      assert.equal(f.calls[1]?.payload.reply_parameters, undefined);
      assert.equal(f.calls[2]?.payload.text, "已删除一条消息");
      assert.deepEqual(f.calls[2]?.payload.reply_parameters, { message_id: 10, allow_sending_without_reply: true });
    }
    f.calls.length = 0;
    await f.send("@examplebot one two three");
    await f.send("@examplebot one two", { private: true });
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("keyword detection still covers captions and usernames after extraction", async () => {
  const f = await fixture();
  try {
    await f.keywords.add("spam");
    await f.send("SPAM offer", { caption: true });
    assert.match(String(f.calls.find((call) => call.method === "sendMessage")?.payload.text), /媒体说明/);
    await f.keywords.clear();
    await f.keywords.add("@user");
    f.calls.length = 0;
    await f.send("ordinary");
    assert.match(String(f.calls[1]?.payload.text), /发送者用户名/);
  } finally { await f.close(); }
});

test("channel update routing converts messages without a configured submission target", async () => {
  const f = await fixture();
  try {
    for (const kind of ["channel_post", "edited_channel_post"]) {
      await f.bot.handleUpdate({ update_id: 100, [kind]: {
        message_id: 20, date: 1, chat: { id: -100456, type: "channel", title: "Channel" },
        text: "标题 (https://telegra.ph/a) | 原文 (https://example.com/a)",
      } } as unknown as Update);
    }
    assert.equal(f.calls.filter((call) => call.method === "editMessageText").length, 2);
    assert.equal(f.calls.some((call) => call.method === "deleteMessage"), false);
  } finally { await f.close(); }
});
