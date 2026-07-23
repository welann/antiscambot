import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import {
  DigestRepository,
  DigestService,
  buildTelegramMessageLink,
  formatDigestChunks,
  getLocalDate,
  parseTelegramMessageLink,
  selectUnusedMessageIds,
  shouldRunDailyCatchUp,
} from "../digest.js";
import type {
  DigestChunk,
  DigestSection,
  SourceChannel,
  SourceChannelInput,
  TargetChannelInput,
} from "../digest.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "antiscambot-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "digest.sqlite");
}

function sourceInput(
  overrides: Partial<SourceChannelInput> = {},
): SourceChannelInput {
  return {
    chatId: -1001234567890,
    title: "来源频道",
    username: "source_channel",
    linkKind: "public",
    linkChannel: "source_channel",
    latestMessageId: 20,
    ...overrides,
  };
}

function targetInput(
  overrides: Partial<TargetChannelInput> = {},
): TargetChannelInput {
  return {
    chatId: -1009876543210,
    title: "目标频道",
    username: "target_channel",
    linkKind: "public",
    linkChannel: "target_channel",
    ...overrides,
  };
}

function asSource(input: SourceChannelInput): SourceChannel {
  return {
    ...input,
    active: true,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("Telegram message link parsing", () => {
  test("parses public and private message links", () => {
    assert.deepEqual(
      parseTelegramMessageLink("https://t.me/example_channel/321?single"),
      {
        chatReference: "@example_channel",
        linkKind: "public",
        linkChannel: "example_channel",
        messageId: 321,
      },
    );
    assert.deepEqual(
      parseTelegramMessageLink("https://t.me/c/1234567890/654?single"),
      {
        chatReference: -1001234567890,
        linkKind: "private",
        linkChannel: "1234567890",
        messageId: 654,
      },
    );
    assert.equal(
      parseTelegramMessageLink("https://t.me/s/example_channel/88").messageId,
      88,
    );
  });

  test("rejects unsupported or malformed links", () => {
    assert.throws(() => parseTelegramMessageLink("https://example.com/a/1"));
    assert.throws(() => parseTelegramMessageLink("https://t.me/c/not-a-chat/1"));
    assert.throws(() => parseTelegramMessageLink("https://t.me/channel/not-an-id"));
  });
});

describe("random selection", () => {
  test("selects only unused IDs and handles exhaustion", () => {
    const sequence = [0, 1, 2];
    const selected = selectUnusedMessageIds(
      5,
      new Set([2, 4]),
      10,
      () => sequence.shift() ?? 0,
    );
    assert.deepEqual(selected, [1, 3, 5]);
    assert.deepEqual(selectUnusedMessageIds(2, new Set([1, 2]), 10), []);
  });
});

describe("digest formatting", () => {
  test("groups multiple channels and escapes HTML", () => {
    const first = asSource(sourceInput({ title: "A & <B>" }));
    const second = asSource(
      sourceInput({
        chatId: -1002222222222,
        title: "第二频道",
        username: null,
        linkKind: "private",
        linkChannel: "2222222222",
      }),
    );
    const sections: DigestSection[] = [
      {
        source: first,
        selections: [
          {
            sourceChatId: first.chatId,
            sourceMessageId: 3,
            sourceTitle: first.title,
            messageLink: buildTelegramMessageLink(first, 3),
          },
        ],
      },
      {
        source: second,
        selections: [
          {
            sourceChatId: second.chatId,
            sourceMessageId: 8,
            sourceTitle: second.title,
            messageLink: buildTelegramMessageLink(second, 8),
          },
        ],
      },
    ];

    const chunks = formatDigestChunks(sections, "2026-07-23");
    assert.equal(chunks.length, 1);
    assert.match(chunks[0]?.html ?? "", /A &amp; &lt;B&gt;/);
    assert.match(chunks[0]?.html ?? "", /https:\/\/t\.me\/source_channel\/3/);
    assert.match(chunks[0]?.html ?? "", /https:\/\/t\.me\/c\/2222222222\/8/);
  });

  test("splits at channel boundaries when the visible text is too long", () => {
    const first = asSource(sourceInput({ title: "频道一" }));
    const second = asSource(
      sourceInput({ chatId: -1002222222222, title: "频道二" }),
    );
    const makeSection = (source: SourceChannel): DigestSection => ({
      source,
      selections: Array.from({ length: 3 }, (_, index) => ({
        sourceChatId: source.chatId,
        sourceMessageId: index + 1,
        sourceTitle: source.title,
        messageLink: buildTelegramMessageLink(source, index + 1),
      })),
    });

    const chunks = formatDigestChunks(
      [makeSection(first), makeSection(second)],
      "2026-07-23",
      90,
    );
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]?.selections.length, 3);
    assert.equal(chunks[1]?.selections.length, 3);
  });
});

describe("SQLite persistence", () => {
  test("restores configuration and permanent deduplication after restart", () => {
    const databasePath = createDatabasePath();
    const repository = new DigestRepository(databasePath);
    const source = repository.upsertSource(sourceInput({ latestMessageId: 3 }));
    repository.setTarget(targetInput());
    const runId = repository.beginRun("manual", "2026-07-23");
    assert.ok(runId);

    const chunk: DigestChunk = {
      html: "<b>digest</b>",
      selections: [
        {
          sourceChatId: source.chatId,
          sourceMessageId: 2,
          sourceTitle: source.title,
          messageLink: buildTelegramMessageLink(source, 2),
        },
      ],
    };
    repository.reserveChunk(runId, 0, chunk);
    repository.markChunkDispatching(runId, 0);
    repository.markChunkSent(runId, 0, 999);
    repository.completeRun(runId);
    repository.close();

    const reopened = new DigestRepository(databasePath);
    assert.equal(reopened.getTarget()?.title, "目标频道");
    assert.deepEqual(Array.from(reopened.getUsedMessageIds(source.chatId)), [2]);
    assert.deepEqual(reopened.listActiveSourceStats().map((item) => ({
      used: item.usedCount,
      remaining: item.remainingCount,
    })), [{ used: 1, remaining: 2 }]);
    reopened.close();

    const database = new DatabaseSync(databasePath);
    const message = database
      .prepare(
        `SELECT html_body, telegram_message_id, status
         FROM digest_messages`,
      )
      .get();
    assert.deepEqual({ ...message }, {
      html_body: "<b>digest</b>",
      telegram_message_id: 999,
      status: "sent",
    });
    const config = database
      .prepare(
        `SELECT cron_expression, timezone, sample_size
         FROM digest_config`,
      )
      .get();
    assert.deepEqual({ ...config }, {
      cron_expression: "0 12 * * *",
      timezone: "Asia/Shanghai",
      sample_size: 10,
    });
    database.close();
  });

  test("keeps reserved IDs after an interrupted run", () => {
    const databasePath = createDatabasePath();
    const repository = new DigestRepository(databasePath);
    const source = repository.upsertSource(sourceInput());
    const runId = repository.beginRun("manual", "2026-07-23");
    assert.ok(runId);
    repository.reserveChunk(runId, 0, {
      html: "pending",
      selections: [
        {
          sourceChatId: source.chatId,
          sourceMessageId: 7,
          sourceTitle: source.title,
          messageLink: buildTelegramMessageLink(source, 7),
        },
      ],
    });
    repository.markChunkDispatching(runId, 0);
    repository.close();

    const reopened = new DigestRepository(databasePath);
    assert.equal(reopened.getUsedMessageIds(source.chatId).has(7), true);
    reopened.close();

    const database = new DatabaseSync(databasePath);
    const run = database
      .prepare("SELECT status FROM digest_runs WHERE id = ?")
      .get(runId);
    assert.deepEqual({ ...run }, { status: "interrupted" });
    database.close();
  });

  test("deactivating and reactivating a source preserves its history", () => {
    const repository = new DigestRepository(":memory:");
    const source = repository.upsertSource(sourceInput({ latestMessageId: 2 }));
    const runId = repository.beginRun("manual", "2026-07-23");
    assert.ok(runId);
    repository.reserveChunk(runId, 0, {
      html: "digest",
      selections: [
        {
          sourceChatId: source.chatId,
          sourceMessageId: 1,
          sourceTitle: source.title,
          messageLink: buildTelegramMessageLink(source, 1),
        },
      ],
    });
    assert.equal(repository.deactivateSourceByIndex(1)?.active, false);
    repository.upsertSource(sourceInput({ latestMessageId: 3 }));
    assert.deepEqual(repository.listActiveSourceStats().map((item) => ({
      latest: item.latestMessageId,
      used: item.usedCount,
    })), [{ latest: 3, used: 1 }]);
    repository.close();
  });

  test("allows only one scheduled run per local date", () => {
    const repository = new DigestRepository(":memory:");
    assert.ok(repository.beginRun("scheduled", "2026-07-23"));
    assert.equal(repository.beginRun("scheduled", "2026-07-23"), null);
    assert.ok(repository.beginRun("scheduled", "2026-07-24"));
    repository.close();
  });

  test("refuses to silently replace a corrupt database", () => {
    const databasePath = createDatabasePath();
    writeFileSync(databasePath, "this is not a SQLite database");
    assert.throws(
      () => new DigestRepository(databasePath),
      /为避免丢失去重记录，程序不会自动重建该文件/,
    );
  });
});

describe("digest service", () => {
  test("sends all remaining IDs without repeating across runs", async () => {
    const repository = new DigestRepository(":memory:");
    repository.upsertSource(sourceInput({ latestMessageId: 12 }));
    repository.setTarget(targetInput());
    const sentHtml: string[] = [];
    const service = new DigestService(
      repository,
      async (_chatId, html) => {
        sentHtml.push(html);
        return { messageId: sentHtml.length };
      },
      10,
    );

    const first = await service.run("manual", "2026-07-23");
    const second = await service.run("manual", "2026-07-23");
    const third = await service.run("manual", "2026-07-23");
    assert.deepEqual(
      [first.itemCount, second.itemCount, third.itemCount],
      [10, 2, 0],
    );
    assert.equal(third.status, "empty");
    assert.equal(repository.listActiveSourceStats()[0]?.usedCount, 12);
    repository.close();
  });

  test("keeps selected IDs reserved after a send failure", async () => {
    const repository = new DigestRepository(":memory:");
    repository.upsertSource(sourceInput({ latestMessageId: 1 }));
    repository.setTarget(targetInput());
    const service = new DigestService(
      repository,
      async () => {
        throw new Error("Telegram unavailable");
      },
      10,
    );

    const failed = await service.run("manual", "2026-07-23");
    const retry = await service.run("manual", "2026-07-23");
    assert.equal(failed.status, "failed");
    assert.equal(failed.itemCount, 1);
    assert.equal(retry.status, "empty");
    assert.equal(repository.listActiveSourceStats()[0]?.usedCount, 1);
    repository.close();
  });
});

describe("daily scheduling helpers", () => {
  test("uses the configured timezone for date and catch-up", () => {
    const beforeNoon = new Date("2026-07-23T03:59:00.000Z");
    const atNoon = new Date("2026-07-23T04:00:00.000Z");
    assert.equal(getLocalDate(atNoon, "Asia/Shanghai"), "2026-07-23");
    assert.equal(
      shouldRunDailyCatchUp("0 12 * * *", "Asia/Shanghai", beforeNoon),
      false,
    );
    assert.equal(
      shouldRunDailyCatchUp("0 12 * * *", "Asia/Shanghai", atNoon),
      true,
    );
    assert.equal(
      shouldRunDailyCatchUp("*/5 * * * *", "Asia/Shanghai", atNoon),
      false,
    );
  });
});
