import assert from "node:assert/strict";
import { test } from "node:test";
import { Api } from "grammy";
import type { Message } from "grammy/types";
import { convertChannelLinks, deleteWithNotice, replyLocation } from "../message-handling.js";

const link = "附言#话题 标题 (https://telegra.ph/a) | 原文 (https://example.com/a)";
const message: Message = {
  message_id: 42, date: 1,
  chat: { id: -100123, type: "channel", title: "A" },
  text: link,
  reply_to_message: { message_id: 10, date: 1, chat: { id: -100123, type: "channel", title: "A" } } as NonNullable<Message["reply_to_message"]>,
};

function mockApi(options: { editAllowed?: boolean; failMethod?: string } = {}) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const api = new Api("123:test");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === options.failMethod) throw new Error("simulated failure");
    const result = method === "getChatMember"
      ? { status: "administrator", can_edit_messages: options.editAllowed ?? true }
      : true;
    return { ok: true, result } as Awaited<ReturnType<typeof _prev>>;
  });
  return { api, calls };
}

test("edits matching posts in any channel at the original message ID", async () => {
  const { api, calls } = mockApi();
  for (const id of [-100123, -100456]) {
    assert.equal(await convertChannelLinks(api, { ...message, chat: { ...message.chat, id } }, 99), true);
  }
  const edits = calls.filter((call) => call.method === "editMessageText");
  assert.deepEqual(edits.map((call) => call.payload.chat_id), [-100123, -100456]);
  for (const { payload } of edits) {
    assert.equal(payload.message_id, 42);
    assert.match(String(payload.text), /^附言#话题\n<a /);
    assert.deepEqual(payload.link_preview_options, { is_disabled: false, url: "https://telegra.ph/a" });
  }
});

test("ignores groups, ordinary posts and converted edit updates without API calls", async () => {
  const { api, calls } = mockApi();
  assert.equal(await convertChannelLinks(api, { ...message, chat: { id: -123, type: "group", title: "B" } }, 99), false);
  assert.equal(await convertChannelLinks(api, { ...message, text: "普通文本" }, 99), false);
  assert.equal(await convertChannelLinks(api, { ...message, text: "附言#话题\n标题 | 原文", entities: [
    { type: "text_link", offset: 6, length: 2, url: "https://telegra.ph/a" },
  ] }, 99), false);
  assert.equal(calls.length, 0);
});

test("does not edit a channel without editing permission", async () => {
  const { api, calls } = mockApi({ editAllowed: false });
  assert.equal(await convertChannelLinks(api, message, 99), false);
  assert.deepEqual(calls.map((call) => call.method), ["getChatMember"]);
});

test("edits media captions without replacing the media", async () => {
  const { api, calls } = mockApi();
  const { text, ...base } = message;
  await convertChannelLinks(api, { ...base, caption: link, photo: [] }, 99);
  assert.equal(calls[1]?.method, "editMessageCaption");
  assert.match(String(calls[1]?.payload.caption), /^附言#话题\n<a /);
});

test("rejects malformed and oversized conversions before editing", async () => {
  const { api, calls } = mockApi();
  await assert.rejects(convertChannelLinks(api, { ...message, text: `${link}\n${"x".repeat(4096)}` }, 99));
  await assert.rejects(convertChannelLinks(api, { ...message, text: "标题 (broken) | 原文 (https://example.com)" }, 99));
  assert.equal(calls.length, 0);
});

test("deletion notice replies to the parent in the same forum topic", async () => {
  const { api, calls } = mockApi();
  await deleteWithNotice(api, { ...message, is_topic_message: true, message_thread_id: 7 }, "deleted", () => "failed");
  assert.deepEqual(calls.map((call) => call.method), ["deleteMessage", "sendMessage"]);
  assert.deepEqual(calls[1]?.payload.reply_parameters, { message_id: 10, allow_sending_without_reply: true });
  assert.equal(calls[1]?.payload.message_thread_id, 7);
  assert.equal(calls[1]?.payload.text, "deleted");
});

test("deletion failures reply to the still-existing offending message", async () => {
  const { api, calls } = mockApi({ failMethod: "deleteMessage" });
  await deleteWithNotice(api, message, "deleted", (reason) => `failed: ${reason}`);
  assert.deepEqual(calls[1]?.payload.reply_parameters, { message_id: 42, allow_sending_without_reply: true });
  assert.equal(calls[1]?.payload.text, "failed: simulated failure");
});

test("notice failure is not mislabeled or retried as a deletion failure", async () => {
  const { api, calls } = mockApi({ failMethod: "sendMessage" });
  let failedDeletion = false;
  await assert.rejects(deleteWithNotice(api, message, "deleted", () => { failedDeletion = true; return "failed"; }));
  assert.equal(failedDeletion, false);
  assert.equal(calls.length, 2);
});

test("standalone deletions do not reply to a deleted message; comments keep their parent", () => {
  const { reply_to_message, ...standalone } = message;
  assert.deepEqual(replyLocation(standalone), {});
  assert.deepEqual(replyLocation({ ...message, message_thread_id: 10 }), {
    reply_parameters: { message_id: 10, allow_sending_without_reply: true },
  });
});
