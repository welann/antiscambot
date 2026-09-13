import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CalendarRepository, CalendarService, CalendarSendRejectedError, calendarDate, calendarIsDue, CALENDAR_CAPTION } from '../calendar.js';

const target = { chatId: -1001234567890, title: '布告栏' };
const morning = new Date('2026-09-13T00:00:00Z');
const image = new Uint8Array([1, 2, 3]);

test('calendar uses UTC+8 day and exact 08:00 boundary independent of host timezone', () => {
  assert.equal(calendarIsDue(new Date('2026-09-12T23:59:59Z')), false);
  assert.equal(calendarIsDue(morning), true);
  assert.equal(calendarIsDue(new Date('2026-09-13T07:00:00Z')), true);
  assert.equal(calendarDate(new Date('2026-09-13T16:00:00Z')), '2026-09-14');
});

test('setting a target immediately sends photo with hashtag; tomorrow gets a new render', async () => {
  const repo = new CalendarRepository(':memory:');
  const rendered: string[] = [], sent: number[] = [];
  const service = new CalendarService(repo, async date => { rendered.push(date); return image; }, async (chat, bytes, caption) => {
    assert.deepEqual(bytes, image); assert.equal(caption, '#布告栏'); assert.equal(caption, CALENDAR_CAPTION); sent.push(chat); return 123;
  });
  try {
    // Setup before 08:00 also satisfies today's edition.
    assert.equal((await service.configureAndSend(target, new Date('2026-09-12T22:00:00Z'))).status, 'sent');
    assert.equal((await service.run(morning)).status, 'already-sent');
    assert.equal((await service.run(new Date('2026-09-14T00:00:00Z'))).status, 'sent');
    assert.deepEqual(rendered, ['2026-09-13', '2026-09-14']);
    assert.deepEqual(sent, [target.chatId, target.chatId]);
    assert.equal(repo.getDelivery(target.chatId, '2026-09-13')?.message_id, 123);
  } finally { repo.close(); }
});

test('settings and daily dedup survive restart, with distinct deliveries for a changed channel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-bot-')); const file = join(dir, 'bot.sqlite');
  let repo = new CalendarRepository(file); let sends = 0;
  const create = () => new CalendarService(repo, async () => image, async () => ++sends);
  try {
    await create().configureAndSend(target, morning); repo.close(); repo = new CalendarRepository(file);
    assert.deepEqual(repo.getTarget(), target);
    const service = create();
    assert.equal((await service.run(morning)).status, 'already-sent');
    assert.equal((await service.configureAndSend({ chatId: -100999, title: '新频道' }, morning)).status, 'sent');
    service.stop(); assert.equal((await service.run(morning)).status, 'not-configured');
    assert.equal(sends, 2);
  } finally { repo.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent runs do not send twice and target changes wait until in-flight work finishes', async () => {
  const repo = new CalendarRepository(':memory:');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  const service = new CalendarService(repo, async () => { await gate; return image; }, async () => ++sends);
  try {
    const run = service.configureAndSend(target, morning);
    assert.equal((await service.run(morning)).status, 'busy');
    assert.throws(() => service.configureAndSend({ chatId: -100555, title: '另一个' }, morning), /正在发送/);
    assert.throws(() => service.stop(), /正在发送/);
    assert.deepEqual(repo.getTarget(), target); release(); await run; await service.idle(); assert.equal(sends, 1);
  } finally { repo.close(); }
});

test('render failures and explicit Telegram rejections can be retried without losing configuration', async () => {
  const repo = new CalendarRepository(':memory:'); let renders = 0, sends = 0;
  const service = new CalendarService(repo, async () => { if (++renders === 1) throw new Error('API offline'); return image; }, async () => {
    if (++sends === 1) throw new CalendarSendRejectedError('Forbidden'); return 15;
  });
  try {
    assert.equal((await service.configureAndSend(target, morning)).status, 'failed');
    assert.deepEqual(repo.getTarget(), target);
    assert.equal((await service.run(morning)).status, 'failed');
    assert.equal((await service.run(morning)).status, 'sent');
    assert.equal(sends, 2);
  } finally { repo.close(); }
});

test('ambiguous network failure is not resent automatically; explicit manual retry is allowed', async () => {
  const repo = new CalendarRepository(':memory:'); let sends = 0;
  const service = new CalendarService(repo, async () => image, async () => { if (++sends === 1) throw new Error('socket reset'); return 22; });
  try {
    assert.equal((await service.configureAndSend(target, morning)).status, 'uncertain');
    assert.equal((await service.run(morning)).status, 'uncertain');
    assert.equal(sends, 1);
    assert.equal((await service.run(morning, true)).status, 'sent');
  } finally { repo.close(); }
});

test('restart makes interrupted renders retryable but preserves uncertain sends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-recover-')); const file = join(dir, 'calendar.sqlite');
  let repo = new CalendarRepository(file);
  try {
    repo.claim(target.chatId, '2026-09-13', false);
    repo.claim(target.chatId, '2026-09-14', false); repo.mark(target.chatId, '2026-09-14', 'sending');
    repo.close(); repo = new CalendarRepository(file);
    assert.equal(repo.getDelivery(target.chatId, '2026-09-13')?.status, 'failed');
    assert.equal(repo.getDelivery(target.chatId, '2026-09-14')?.status, 'uncertain');
    assert.equal(repo.claim(target.chatId, '2026-09-14', false), false);
  } finally { repo.close(); rmSync(dir, { recursive: true, force: true }); }
});
