import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 2;
const MAX_TELEGRAM_MESSAGE_ID = 2_147_483_647;
const DEFAULT_MESSAGE_LENGTH_LIMIT = 4_096;
export const MAX_DIGEST_SAMPLE_SIZE = 100;

type DatabaseRow = Record<string, unknown>;

export type LinkKind = "public" | "private";
export type DigestTrigger = "manual" | "scheduled";

export interface ParsedTelegramMessageLink {
  chatReference: string | number;
  linkKind: LinkKind;
  linkChannel: string;
  messageId: number;
}

export interface SourceChannel {
  chatId: number;
  title: string;
  username: string | null;
  linkKind: LinkKind;
  linkChannel: string;
  latestMessageId: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SourceChannelInput {
  chatId: number;
  title: string;
  username: string | null;
  linkKind: LinkKind;
  linkChannel: string;
  latestMessageId: number;
}

export interface SourceChannelStats extends SourceChannel {
  usedCount: number;
  remainingCount: number;
}

export interface TargetChannel {
  chatId: number;
  title: string;
  username: string | null;
  linkKind: LinkKind;
  linkChannel: string;
  updatedAt: string;
}

export interface TargetChannelInput {
  chatId: number;
  title: string;
  username: string | null;
  linkKind: LinkKind;
  linkChannel: string;
}

export interface LinkSubmissionTarget {
  chatId: number;
  title: string;
}

export interface LinkSubmissionTargetInput {
  chatId: number;
  title: string;
}

export interface DigestRuntimeConfig {
  cronExpression: string;
  timeZone: string;
  sampleSize: number;
}

export interface DigestSelection {
  sourceChatId: number;
  sourceMessageId: number;
  sourceTitle: string;
  messageLink: string;
}

export interface DigestSection {
  source: SourceChannel;
  selections: DigestSelection[];
}

export interface DigestChunk {
  html: string;
  selections: DigestSelection[];
}

interface FailedDigestChunk {
  runId: string;
  chunkIndex: number;
  html: string;
}

export interface DigestSendResult {
  messageId: number;
}

export type DigestSender = (
  targetChatId: number,
  html: string,
) => Promise<DigestSendResult>;

export interface DigestRunResult {
  status:
    | "sent"
    | "empty"
    | "busy"
    | "already-ran"
    | "not-configured"
    | "failed";
  itemCount: number;
  messageCount: number;
  error: string | null;
}

export interface DigestServiceOptions {
  sendMaxAttempts?: number;
  retryDelayMs?: number;
}

const DEFAULT_SEND_MAX_ATTEMPTS = 3;
const DEFAULT_SEND_RETRY_DELAY_MS = 1_000;
const MAX_SEND_RETRY_DELAY_MS = 30_000;

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`SQLite field ${field} is not a safe integer`);
  }
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`SQLite field ${field} is not a string`);
  }
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return asString(value, field);
}

function parseLinkKind(value: unknown): LinkKind {
  if (value === "public" || value === "private") return value;
  throw new Error(`SQLite field link_kind has invalid value: ${String(value)}`);
}

function sourceFromRow(row: DatabaseRow): SourceChannel {
  return {
    chatId: asNumber(row.chat_id, "chat_id"),
    title: asString(row.title, "title"),
    username: asNullableString(row.username, "username"),
    linkKind: parseLinkKind(row.link_kind),
    linkChannel: asString(row.link_channel, "link_channel"),
    latestMessageId: asNumber(row.latest_message_id, "latest_message_id"),
    active: asNumber(row.active, "active") === 1,
    createdAt: asString(row.created_at, "created_at"),
    updatedAt: asString(row.updated_at, "updated_at"),
  };
}

function targetFromRow(row: DatabaseRow): TargetChannel {
  return {
    chatId: asNumber(row.target_chat_id, "target_chat_id"),
    title: asString(row.target_title, "target_title"),
    username: asNullableString(row.target_username, "target_username"),
    linkKind: parseLinkKind(row.target_link_kind),
    linkChannel: asString(row.target_link_channel, "target_link_channel"),
    updatedAt: asString(row.updated_at, "updated_at"),
  };
}

function linkSubmissionTargetFromRow(row: DatabaseRow): LinkSubmissionTarget {
  return {
    chatId: asNumber(row.target_chat_id, "target_chat_id"),
    title: asString(row.target_title, "target_title"),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class DigestRepository {
  private readonly db: DatabaseSync;
  private readonly runtimeConfig: DigestRuntimeConfig;

  constructor(
    readonly databaseFile: string,
    runtimeConfig: DigestRuntimeConfig = {
      cronExpression: "0 12 * * *",
      timeZone: "Asia/Shanghai",
      sampleSize: 10,
    },
  ) {
    this.runtimeConfig = runtimeConfig;
    if (databaseFile !== ":memory:") {
      mkdirSync(dirname(databaseFile), { recursive: true });
    }

    try {
      this.db = new DatabaseSync(databaseFile, {
        enableForeignKeyConstraints: true,
        timeout: 5_000,
      });
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA synchronous = FULL");
      if (databaseFile !== ":memory:") {
        this.db.exec("PRAGMA journal_mode = WAL");
      }
      this.assertHealthy();
      this.migrate();
      this.syncRuntimeConfiguration();
      this.recoverInterruptedRuns();
    } catch (error) {
      throw new Error(
        `无法打开摘要数据库 ${databaseFile}：${errorMessage(error)}。为避免丢失去重记录，程序不会自动重建该文件。`,
        { cause: error },
      );
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private assertHealthy(): void {
    const row = this.db.prepare("PRAGMA quick_check").get() as DatabaseRow | undefined;
    if (!row || row.quick_check !== "ok") {
      throw new Error(`PRAGMA quick_check failed: ${String(row?.quick_check ?? "no result")}`);
    }
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as DatabaseRow | undefined;
    const currentVersion = row ? asNumber(row.user_version, "user_version") : 0;
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `数据库 schema 版本 ${currentVersion} 高于当前程序支持的 ${SCHEMA_VERSION}`,
      );
    }
    if (currentVersion === SCHEMA_VERSION) return;

    this.transaction(() => {
      if (currentVersion < 1) {
        this.db.exec(`
          CREATE TABLE source_channels (
            chat_id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            username TEXT,
            link_kind TEXT NOT NULL CHECK (link_kind IN ('public', 'private')),
            link_channel TEXT NOT NULL,
            latest_message_id INTEGER NOT NULL CHECK (latest_message_id > 0),
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE digest_config (
            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
            target_chat_id INTEGER,
            target_title TEXT,
            target_username TEXT,
            target_link_kind TEXT
              CHECK (
                target_link_kind IS NULL
                OR target_link_kind IN ('public', 'private')
              ),
            target_link_channel TEXT,
            cron_expression TEXT NOT NULL,
            timezone TEXT NOT NULL,
            sample_size INTEGER NOT NULL CHECK (sample_size > 0),
            updated_at TEXT NOT NULL
          );

          CREATE TABLE digest_runs (
            id TEXT PRIMARY KEY,
            trigger_type TEXT NOT NULL
              CHECK (trigger_type IN ('manual', 'scheduled')),
            scheduled_date TEXT,
            status TEXT NOT NULL
              CHECK (status IN (
                'preparing',
                'dispatching',
                'completed',
                'failed',
                'interrupted'
              )),
            started_at TEXT NOT NULL,
            completed_at TEXT,
            error TEXT
          );

          CREATE UNIQUE INDEX digest_runs_scheduled_date_unique
          ON digest_runs(scheduled_date)
          WHERE trigger_type = 'scheduled';

          CREATE TABLE digest_items (
            source_chat_id INTEGER NOT NULL
              REFERENCES source_channels(chat_id),
            source_message_id INTEGER NOT NULL,
            run_id TEXT NOT NULL REFERENCES digest_runs(id),
            chunk_index INTEGER NOT NULL,
            message_link TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('reserved', 'sent')),
            reserved_at TEXT NOT NULL,
            sent_at TEXT,
            PRIMARY KEY (source_chat_id, source_message_id)
          );

          CREATE INDEX digest_items_run_chunk_index
          ON digest_items(run_id, chunk_index);

          CREATE TABLE digest_messages (
            run_id TEXT NOT NULL REFERENCES digest_runs(id),
            chunk_index INTEGER NOT NULL,
            html_body TEXT NOT NULL,
            telegram_message_id INTEGER,
            status TEXT NOT NULL
              CHECK (status IN (
                'reserved',
                'dispatching',
                'sent',
                'failed',
                'interrupted'
              )),
            created_at TEXT NOT NULL,
            sent_at TEXT,
            error TEXT,
            PRIMARY KEY (run_id, chunk_index)
          );
        `);
      }
      if (currentVersion < 2) {
        this.db.exec(`
          CREATE TABLE link_submission_config (
            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
            target_chat_id INTEGER,
            target_title TEXT,
            updated_at TEXT NOT NULL
          );
        `);
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private syncRuntimeConfiguration(): void {
    const timestamp = nowIso();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO digest_config (
             singleton_id,
             cron_expression,
             timezone,
             sample_size,
             updated_at
           ) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(singleton_id) DO UPDATE SET
             cron_expression = excluded.cron_expression,
             timezone = excluded.timezone,
             updated_at = excluded.updated_at`,
        )
        .run(
          this.runtimeConfig.cronExpression,
          this.runtimeConfig.timeZone,
          this.runtimeConfig.sampleSize,
          timestamp,
        );
    });
  }

  private recoverInterruptedRuns(): void {
    const timestamp = nowIso();
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE digest_messages
           SET status = 'interrupted',
               error = COALESCE(error, 'Bot restarted before delivery was confirmed')
           WHERE status IN ('reserved', 'dispatching')`,
        )
        .run();
      this.db
        .prepare(
          `UPDATE digest_runs
           SET status = 'interrupted',
               completed_at = ?,
               error = COALESCE(error, 'Bot restarted before the digest completed')
           WHERE status IN ('preparing', 'dispatching')`,
        )
        .run(timestamp);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  getTarget(): TargetChannel | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM digest_config
         WHERE singleton_id = 1 AND target_chat_id IS NOT NULL`,
      )
      .get() as DatabaseRow | undefined;
    return row ? targetFromRow(row) : null;
  }

  getSampleSize(): number {
    const row = this.db
      .prepare(
        `SELECT sample_size
         FROM digest_config
         WHERE singleton_id = 1`,
      )
      .get() as DatabaseRow | undefined;
    if (!row) throw new Error("摘要运行配置尚未初始化");
    return asNumber(row.sample_size, "sample_size");
  }

  getLinkSubmissionTarget(): LinkSubmissionTarget | null {
    const row = this.db
      .prepare(
        `SELECT target_chat_id, target_title
         FROM link_submission_config
         WHERE singleton_id = 1 AND target_chat_id IS NOT NULL`,
      )
      .get() as DatabaseRow | undefined;
    return row ? linkSubmissionTargetFromRow(row) : null;
  }

  setLinkSubmissionTarget(
    target: LinkSubmissionTargetInput,
  ): LinkSubmissionTarget {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO link_submission_config (
             singleton_id,
             target_chat_id,
             target_title,
             updated_at
           ) VALUES (1, ?, ?, ?)
           ON CONFLICT(singleton_id) DO UPDATE SET
             target_chat_id = excluded.target_chat_id,
             target_title = excluded.target_title,
             updated_at = excluded.updated_at`,
        )
        .run(target.chatId, target.title, nowIso());
    });

    const saved = this.getLinkSubmissionTarget();
    if (!saved) throw new Error("投稿目标频道保存失败");
    return saved;
  }

  setSampleSize(sampleSize: number): number {
    if (
      !Number.isSafeInteger(sampleSize) ||
      sampleSize <= 0 ||
      sampleSize > MAX_DIGEST_SAMPLE_SIZE
    ) {
      throw new Error(`每日抽样数量必须是 1 到 ${MAX_DIGEST_SAMPLE_SIZE} 的整数`);
    }

    this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE digest_config
           SET sample_size = ?, updated_at = ?
           WHERE singleton_id = 1`,
        )
        .run(sampleSize, nowIso());
      if (Number(result.changes) !== 1) {
        throw new Error("摘要运行配置尚未初始化");
      }
    });
    return sampleSize;
  }

  setTarget(target: TargetChannelInput): TargetChannel {
    const timestamp = nowIso();
    this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE digest_config
           SET target_chat_id = ?,
               target_title = ?,
               target_username = ?,
               target_link_kind = ?,
               target_link_channel = ?,
               updated_at = ?
           WHERE singleton_id = 1`,
        )
        .run(
          target.chatId,
          target.title,
          target.username,
          target.linkKind,
          target.linkChannel,
          timestamp,
        );
      if (Number(result.changes) !== 1) {
        throw new Error("摘要运行配置尚未初始化");
      }
    });

    const saved = this.getTarget();
    if (!saved) throw new Error("目标频道保存失败");
    return saved;
  }

  upsertSource(source: SourceChannelInput): SourceChannel {
    const timestamp = nowIso();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO source_channels (
             chat_id,
             title,
             username,
             link_kind,
             link_channel,
             latest_message_id,
             active,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             title = excluded.title,
             username = excluded.username,
             link_kind = excluded.link_kind,
             link_channel = excluded.link_channel,
             latest_message_id = MAX(
               source_channels.latest_message_id,
               excluded.latest_message_id
             ),
             active = 1,
             updated_at = excluded.updated_at`,
        )
        .run(
          source.chatId,
          source.title,
          source.username,
          source.linkKind,
          source.linkChannel,
          source.latestMessageId,
          timestamp,
          timestamp,
        );
    });

    const saved = this.getSource(source.chatId);
    if (!saved) throw new Error("来源频道保存失败");
    return saved;
  }

  getSource(chatId: number): SourceChannel | null {
    const row = this.db
      .prepare("SELECT * FROM source_channels WHERE chat_id = ?")
      .get(chatId) as DatabaseRow | undefined;
    return row ? sourceFromRow(row) : null;
  }

  listActiveSources(): SourceChannel[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM source_channels
         WHERE active = 1
         ORDER BY LOWER(title), chat_id`,
      )
      .all() as DatabaseRow[];
    return rows.map(sourceFromRow);
  }

  listActiveSourceStats(): SourceChannelStats[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, COUNT(i.source_message_id) AS used_count
         FROM source_channels AS s
         LEFT JOIN digest_items AS i ON i.source_chat_id = s.chat_id
         WHERE s.active = 1
         GROUP BY s.chat_id
         ORDER BY LOWER(s.title), s.chat_id`,
      )
      .all() as DatabaseRow[];

    return rows.map((row) => {
      const source = sourceFromRow(row);
      const usedCount = asNumber(row.used_count, "used_count");
      return {
        ...source,
        usedCount,
        remainingCount: Math.max(0, source.latestMessageId - usedCount),
      };
    });
  }

  deactivateSourceByIndex(index: number): SourceChannel | null {
    const sources = this.listActiveSources();
    const source = sources[index - 1];
    if (!source) return null;

    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE source_channels
           SET active = 0, updated_at = ?
           WHERE chat_id = ?`,
        )
        .run(nowIso(), source.chatId);
    });
    return { ...source, active: false };
  }

  updateLatestMessageId(chatId: number, messageId: number): boolean {
    if (
      !Number.isSafeInteger(messageId) ||
      messageId <= 0 ||
      messageId > MAX_TELEGRAM_MESSAGE_ID
    ) {
      return false;
    }

    const result = this.db
      .prepare(
        `UPDATE source_channels
         SET latest_message_id = ?, updated_at = ?
         WHERE chat_id = ?
           AND active = 1
           AND latest_message_id < ?`,
      )
      .run(messageId, nowIso(), chatId, messageId);
    return Number(result.changes) > 0;
  }

  getUsedMessageIds(chatId: number): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT source_message_id
         FROM digest_items
         WHERE source_chat_id = ?
         ORDER BY source_message_id`,
      )
      .all(chatId) as DatabaseRow[];

    return new Set(
      rows.map((row) => asNumber(row.source_message_id, "source_message_id")),
    );
  }

  beginRun(trigger: DigestTrigger, scheduledDate: string): string | null {
    if (trigger === "scheduled" && this.hasScheduledRun(scheduledDate)) {
      return null;
    }

    const runId = randomUUID();
    try {
      this.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO digest_runs (
               id,
               trigger_type,
               scheduled_date,
               status,
               started_at
             ) VALUES (?, ?, ?, 'preparing', ?)`,
          )
          .run(
            runId,
            trigger,
            trigger === "scheduled" ? scheduledDate : null,
            nowIso(),
          );
      });
      return runId;
    } catch (error) {
      if (trigger === "scheduled" && this.hasScheduledRun(scheduledDate)) {
        return null;
      }
      throw error;
    }
  }

  hasScheduledRun(scheduledDate: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found
         FROM digest_runs
         WHERE trigger_type = 'scheduled' AND scheduled_date = ?
         LIMIT 1`,
      )
      .get(scheduledDate) as DatabaseRow | undefined;
    return row?.found === 1;
  }

  reserveChunk(runId: string, chunkIndex: number, chunk: DigestChunk): void {
    const timestamp = nowIso();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO digest_messages (
             run_id,
             chunk_index,
             html_body,
             status,
             created_at
           ) VALUES (?, ?, ?, 'reserved', ?)`,
        )
        .run(runId, chunkIndex, chunk.html, timestamp);

      const insertItem = this.db.prepare(
        `INSERT INTO digest_items (
           source_chat_id,
           source_message_id,
           run_id,
           chunk_index,
           message_link,
           status,
           reserved_at
         ) VALUES (?, ?, ?, ?, ?, 'reserved', ?)`,
      );
      for (const selection of chunk.selections) {
        insertItem.run(
          selection.sourceChatId,
          selection.sourceMessageId,
          runId,
          chunkIndex,
          selection.messageLink,
          timestamp,
        );
      }
    });
  }

  markChunkDispatching(runId: string, chunkIndex: number): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE digest_messages
           SET status = 'dispatching'
           WHERE run_id = ? AND chunk_index = ?`,
        )
        .run(runId, chunkIndex);
      this.db
        .prepare(
          `UPDATE digest_runs
           SET status = 'dispatching'
           WHERE id = ?`,
        )
        .run(runId);
    });
  }

  markChunkSent(
    runId: string,
    chunkIndex: number,
    telegramMessageId: number,
  ): void {
    const timestamp = nowIso();
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE digest_messages
           SET status = 'sent',
               telegram_message_id = ?,
               sent_at = ?,
               error = NULL
           WHERE run_id = ? AND chunk_index = ?`,
        )
        .run(telegramMessageId, timestamp, runId, chunkIndex);
      this.db
        .prepare(
          `UPDATE digest_items
           SET status = 'sent', sent_at = ?
           WHERE run_id = ? AND chunk_index = ?`,
        )
        .run(timestamp, runId, chunkIndex);
    });
  }

  markChunkFailed(runId: string, chunkIndex: number, error: string): void {
    const timestamp = nowIso();
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE digest_messages
           SET status = 'failed', error = ?
           WHERE run_id = ? AND chunk_index = ?`,
        )
        .run(error, runId, chunkIndex);
      this.db
        .prepare(
          `UPDATE digest_runs
           SET status = 'failed', completed_at = ?, error = ?
           WHERE id = ?`,
        )
        .run(timestamp, error, runId);
    });
  }

  listFailedChunks(): FailedDigestChunk[] {
    const rows = this.db
      .prepare(
        `SELECT m.run_id, m.chunk_index, m.html_body
         FROM digest_messages AS m
         INNER JOIN digest_runs AS r ON r.id = m.run_id
         WHERE m.status = 'failed'
         ORDER BY r.started_at, m.chunk_index`,
      )
      .all() as DatabaseRow[];
    return rows.map((row) => ({
      runId: asString(row.run_id, "run_id"),
      chunkIndex: asNumber(row.chunk_index, "chunk_index"),
      html: asString(row.html_body, "html_body"),
    }));
  }

  completeRunIfAllChunksSent(runId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS pending_count
         FROM digest_messages
         WHERE run_id = ? AND status <> 'sent'`,
      )
      .get(runId) as DatabaseRow | undefined;
    if (!row || asNumber(row.pending_count, "pending_count") !== 0) return false;

    this.completeRun(runId);
    return true;
  }

  completeRun(runId: string): void {
    this.db
      .prepare(
        `UPDATE digest_runs
         SET status = 'completed', completed_at = ?, error = NULL
         WHERE id = ?`,
      )
      .run(nowIso(), runId);
  }

  failRun(runId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE digest_runs
         SET status = 'failed', completed_at = ?, error = ?
         WHERE id = ? AND status NOT IN ('completed', 'failed')`,
      )
      .run(nowIso(), error, runId);
  }

  getRunItemCount(runId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS item_count
         FROM digest_items
         WHERE run_id = ?`,
      )
      .get(runId) as DatabaseRow | undefined;
    return row ? asNumber(row.item_count, "item_count") : 0;
  }
}

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

function upperBound(sortedValues: number[], target: number): number {
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = sortedValues[middle];
    if (value !== undefined && value <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function availableIdAtRank(
  rank: number,
  maxMessageId: number,
  usedSorted: number[],
): number {
  let low = 1;
  let high = maxMessageId;
  const desiredCount = rank + 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const usedThroughMiddle = upperBound(usedSorted, middle);
    const availableThroughMiddle = middle - usedThroughMiddle;
    if (availableThroughMiddle >= desiredCount) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

export function selectUnusedMessageIds(
  maxMessageId: number,
  usedMessageIds: ReadonlySet<number>,
  requestedCount: number,
  chooseRandomInt: (maxExclusive: number) => number = randomInt,
): number[] {
  if (!Number.isSafeInteger(maxMessageId) || maxMessageId <= 0) return [];
  if (!Number.isSafeInteger(requestedCount) || requestedCount <= 0) return [];

  const usedSorted = Array.from(usedMessageIds)
    .filter((id) => Number.isSafeInteger(id) && id >= 1 && id <= maxMessageId)
    .sort((a, b) => a - b);
  const remainingCount = maxMessageId - usedSorted.length;
  const desiredCount = Math.min(requestedCount, remainingCount);
  if (desiredCount <= 0) return [];

  const selectedRanks = new Set<number>();
  while (selectedRanks.size < desiredCount) {
    const value = chooseRandomInt(remainingCount);
    if (!Number.isSafeInteger(value) || value < 0 || value >= remainingCount) {
      throw new Error("随机数生成器返回了范围外的值");
    }
    selectedRanks.add(value);
  }

  return Array.from(selectedRanks, (rank) =>
    availableIdAtRank(rank, maxMessageId, usedSorted),
  );
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

export function getLocalDate(
  date: Date,
  timeZone: string,
): string {
  const parts = getZonedDateParts(date, timeZone);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

export function getZonedDateParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = new Map(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new Error(`无法按时区 ${timeZone} 解析时间`);
  }
  return { year, month, day, hour, minute };
}

export function shouldRunDailyCatchUp(
  cronExpression: string,
  timeZone: string,
  date: Date,
): boolean {
  const match = cronExpression
    .trim()
    .match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (!match) return false;

  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return false;

  const local = getZonedDateParts(date, timeZone);
  return local.hour > hour || (local.hour === hour && local.minute >= minute);
}

export class DigestService {
  private running = false;
  private readonly sendMaxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly repository: DigestRepository,
    private readonly sender: DigestSender,
    private sampleSize: number,
    options: DigestServiceOptions = {},
  ) {
    this.sendMaxAttempts = options.sendMaxAttempts ?? DEFAULT_SEND_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_SEND_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(this.sendMaxAttempts) || this.sendMaxAttempts <= 0) {
      throw new Error("sendMaxAttempts must be a positive integer");
    }
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error("retryDelayMs must be a non-negative integer");
    }
    this.setSampleSize(sampleSize);
  }

  private async sendWithRetry(
    targetChatId: number,
    html: string,
  ): Promise<DigestSendResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.sendMaxAttempts; attempt += 1) {
      try {
        return await this.sender(targetChatId, html);
      } catch (error) {
        lastError = error;
        if (attempt === this.sendMaxAttempts) break;

        const delayMs = Math.min(
          this.retryDelayMs * 2 ** (attempt - 1),
          MAX_SEND_RETRY_DELAY_MS,
        );
        if (delayMs > 0) await waitForRetry(delayMs);
      }
    }

    throw new Error(
      `发送失败，已尝试 ${this.sendMaxAttempts} 次：${errorMessage(lastError)}`,
      { cause: lastError },
    );
  }

  setSampleSize(sampleSize: number): void {
    if (
      !Number.isSafeInteger(sampleSize) ||
      sampleSize <= 0 ||
      sampleSize > MAX_DIGEST_SAMPLE_SIZE
    ) {
      throw new Error(`sampleSize must be an integer between 1 and ${MAX_DIGEST_SAMPLE_SIZE}`);
    }
    this.sampleSize = sampleSize;
  }

  private getItemCountForRuns(runIds: Set<string>): number {
    let itemCount = 0;
    for (const runId of runIds) {
      itemCount += this.repository.getRunItemCount(runId);
    }
    return itemCount;
  }

  private async retryFailedChunks(
    targetChatId: number,
  ): Promise<DigestRunResult | null> {
    const chunks = this.repository.listFailedChunks();
    if (!chunks.length) return null;

    const runIds = new Set(chunks.map((chunk) => chunk.runId));
    let sentMessages = 0;
    for (const chunk of chunks) {
      this.repository.markChunkDispatching(chunk.runId, chunk.chunkIndex);
      try {
        const result = await this.sendWithRetry(targetChatId, chunk.html);
        this.repository.markChunkSent(chunk.runId, chunk.chunkIndex, result.messageId);
        this.repository.completeRunIfAllChunksSent(chunk.runId);
        sentMessages += 1;
      } catch (error) {
        const reason = errorMessage(error);
        this.repository.markChunkFailed(chunk.runId, chunk.chunkIndex, reason);
        return {
          status: "failed",
          itemCount: this.getItemCountForRuns(runIds),
          messageCount: sentMessages,
          error: reason,
        };
      }
    }

    return {
      status: "sent",
      itemCount: this.getItemCountForRuns(runIds),
      messageCount: sentMessages,
      error: null,
    };
  }

  async run(
    trigger: DigestTrigger,
    localDate: string,
  ): Promise<DigestRunResult> {
    if (this.running) {
      return {
        status: "busy",
        itemCount: 0,
        messageCount: 0,
        error: "已有摘要任务正在运行",
      };
    }

    const target = this.repository.getTarget();
    if (!target) {
      return {
        status: "not-configured",
        itemCount: 0,
        messageCount: 0,
        error: "尚未设置目标频道",
      };
    }

    this.running = true;
    let runId: string | null = null;
    try {
      const retriedResult = await this.retryFailedChunks(target.chatId);
      if (retriedResult) return retriedResult;

      const sources = this.repository.listActiveSources();
      if (!sources.length) {
        return {
          status: "not-configured",
          itemCount: 0,
          messageCount: 0,
          error: "尚未添加来源频道",
        };
      }

      runId = this.repository.beginRun(trigger, localDate);
      if (!runId) {
        return {
          status: "already-ran",
          itemCount: 0,
          messageCount: 0,
          error: null,
        };
      }

      const sections: DigestSection[] = [];
      for (const source of sources) {
        const usedIds = this.repository.getUsedMessageIds(source.chatId);
        const selectedIds = selectUnusedMessageIds(
          source.latestMessageId,
          usedIds,
          this.sampleSize,
        );
        if (!selectedIds.length) continue;

        sections.push({
          source,
          selections: selectedIds.map((messageId) => ({
            sourceChatId: source.chatId,
            sourceMessageId: messageId,
            sourceTitle: source.title,
            messageLink: buildTelegramMessageLink(source, messageId),
          })),
        });
      }

      const chunks = formatDigestChunks(sections, localDate);
      if (!chunks.length) {
        this.repository.completeRun(runId);
        return {
          status: "empty",
          itemCount: 0,
          messageCount: 0,
          error: null,
        };
      }

      let sentMessages = 0;
      for (const [chunkIndex, chunk] of chunks.entries()) {
        this.repository.reserveChunk(runId, chunkIndex, chunk);
        this.repository.markChunkDispatching(runId, chunkIndex);
        try {
          const result = await this.sendWithRetry(target.chatId, chunk.html);
          this.repository.markChunkSent(runId, chunkIndex, result.messageId);
          sentMessages += 1;
        } catch (error) {
          const reason = errorMessage(error);
          this.repository.markChunkFailed(runId, chunkIndex, reason);
          return {
            status: "failed",
            itemCount: this.repository.getRunItemCount(runId),
            messageCount: sentMessages,
            error: reason,
          };
        }
      }

      this.repository.completeRun(runId);
      return {
        status: "sent",
        itemCount: this.repository.getRunItemCount(runId),
        messageCount: sentMessages,
        error: null,
      };
    } catch (error) {
      const reason = errorMessage(error);
      if (runId) this.repository.failRun(runId, reason);
      return {
        status: "failed",
        itemCount: runId ? this.repository.getRunItemCount(runId) : 0,
        messageCount: 0,
        error: reason,
      };
    } finally {
      this.running = false;
    }
  }
}
