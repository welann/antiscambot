import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getLocalDate, shouldRunDailyCatchUp } from './digest.js';

export const CALENDAR_CRON = '0 8 * * *';
export const CALENDAR_TIMEZONE = 'Asia/Shanghai';
export const CALENDAR_CAPTION = '#布告栏';
export type CalendarTarget = { chatId: number; title: string };
export type CalendarDelivery = {
  chat_id: number; local_date: string; status: string;
  message_id: number | null; error: string | null;
};
export type CalendarResult = {
  status: 'sent' | 'already-sent' | 'not-configured' | 'busy' | 'failed' | 'uncertain';
  error?: string;
};
// Telegram returned an explicit rejection: the request did not create a message.
export class CalendarSendRejectedError extends Error {}

export class CalendarRepository {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS calendar_config (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        chat_id INTEGER NOT NULL, title TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calendar_deliveries (
        chat_id INTEGER NOT NULL, local_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('rendering','sending','sent','failed','uncertain')),
        message_id INTEGER, error TEXT,
        PRIMARY KEY(chat_id, local_date)
      );`);
    // A render can safely restart. A send interrupted after dispatch may have succeeded.
    this.db.exec(`UPDATE calendar_deliveries SET status='failed', error='生成图片时 Bot 重启，可重试'
      WHERE status='rendering';
      UPDATE calendar_deliveries SET status='uncertain', error='发送过程中 Bot 重启，请先检查频道'
      WHERE status='sending';`);
  }
  close(): void { this.db.close(); }
  getTarget(): CalendarTarget | null {
    const row = this.db.prepare('SELECT chat_id, title FROM calendar_config WHERE singleton=1').get();
    return row ? { chatId: Number(row.chat_id), title: String(row.title) } : null;
  }
  setTarget(target: CalendarTarget): void {
    this.db.prepare(`INSERT INTO calendar_config VALUES(1,?,?)
      ON CONFLICT(singleton) DO UPDATE SET chat_id=excluded.chat_id,title=excluded.title`).run(target.chatId, target.title);
  }
  stop(): void { this.db.exec('DELETE FROM calendar_config'); }
  getDelivery(chatId: number, date: string): CalendarDelivery | null {
    return (this.db.prepare('SELECT * FROM calendar_deliveries WHERE chat_id=? AND local_date=?').get(chatId, date) as CalendarDelivery | undefined) ?? null;
  }
  claim(chatId: number, date: string, retryUncertain: boolean): boolean {
    const result = this.db.prepare(`INSERT INTO calendar_deliveries(chat_id, local_date, status) VALUES(?,?,'rendering')
      ON CONFLICT(chat_id, local_date) DO UPDATE SET status='rendering',error=NULL
      WHERE calendar_deliveries.status='failed' OR (?=1 AND calendar_deliveries.status='uncertain')`).run(chatId, date, Number(retryUncertain));
    return Number(result.changes) === 1;
  }
  mark(chatId: number, date: string, status: string, messageId: number | null = null, error: string | null = null): void {
    this.db.prepare('UPDATE calendar_deliveries SET status=?, message_id=?, error=? WHERE chat_id=? AND local_date=?').run(status, messageId, error, chatId, date);
  }
}

export function calendarDate(now = new Date()): string { return getLocalDate(now, CALENDAR_TIMEZONE); }
export function calendarIsDue(now = new Date()): boolean { return shouldRunDailyCatchUp(CALENDAR_CRON, CALENDAR_TIMEZONE, now); }

export class CalendarService {
  private running: Promise<CalendarResult> | null = null;
  constructor(
    readonly repository: CalendarRepository,
    private readonly render: (date: string) => Promise<Uint8Array>,
    private readonly send: (target: number, image: Uint8Array, caption: string) => Promise<number>,
  ) {}
  configureAndSend(target: CalendarTarget, now = new Date()): Promise<CalendarResult> {
    if (this.running) throw new Error('日历图片正在发送，请完成后再修改目标频道');
    this.repository.setTarget(target);
    return this.run(now);
  }
  stop(): void {
    if (this.running) throw new Error('日历图片正在发送，请完成后再停用');
    this.repository.stop();
  }
  async idle(): Promise<void> { await this.running; }
  run(now = new Date(), retryUncertain = false): Promise<CalendarResult> {
    if (this.running) return Promise.resolve({ status: 'busy' });
    this.running = this.deliver(now, retryUncertain).finally(() => { this.running = null; });
    return this.running;
  }
  private async deliver(now: Date, retryUncertain: boolean): Promise<CalendarResult> {
    const target = this.repository.getTarget();
    if (!target) return { status: 'not-configured' };
    const date = calendarDate(now);
    if (!this.repository.claim(target.chatId, date, retryUncertain)) {
      const previous = this.repository.getDelivery(target.chatId, date);
      return { status: previous?.status === 'sent' ? 'already-sent' : previous?.status === 'uncertain' ? 'uncertain' : 'busy' };
    }
    let sending = false;
    let sentMessageId: number | null = null;
    try {
      const image = await this.render(date);
      this.repository.mark(target.chatId, date, 'sending');
      sending = true;
      sentMessageId = await this.send(target.chatId, image, CALENDAR_CAPTION);
      this.repository.mark(target.chatId, date, 'sent', sentMessageId);
      return { status: 'sent' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const status = sending && !(error instanceof CalendarSendRejectedError) ? 'uncertain' : 'failed';
      this.repository.mark(target.chatId, date, status, sentMessageId, reason);
      return { status, error: reason };
    }
  }
}

export function formatCalendarResult(result: CalendarResult): string {
  switch (result.status) {
    case 'sent': return '今日日历已发送，图片说明为 #布告栏。';
    case 'already-sent': return '该频道今天已发送日历，不重复发送。';
    case 'not-configured': return '尚未设置布告栏频道，请先使用 /setcalendartarget <频道帖子链接>。';
    case 'busy': return '日历图片正在生成或发送，请稍后查看。';
    case 'failed': return `日历发送失败：${result.error ?? '未知错误'}。配置已保留，可用 /calendarnow 重试。`;
    case 'uncertain': return `上次发送结果不明，请先检查频道。确认未收到后，可用 /calendarnow 手动补发。${result.error ? `\n原因：${result.error}` : ''}`;
  }
}

export async function renderCalendarImage(date: string): Promise<Uint8Array> {
  // Load only when configured, so the rest of the bot can boot without a browser.
  const moduleUrl = new URL('./calendar-studio/renderer.js', import.meta.url).href;
  const renderer = await import(moduleUrl) as {
    generateImage(input: { date: string; scale: number }): Promise<{ buffer: Uint8Array }>;
  };
  const { buffer } = await renderer.generateImage({ date, scale: 1 });
  return buffer;
}
