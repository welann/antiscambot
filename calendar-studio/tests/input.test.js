import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, prepareInput, fetchSentence, wrapQuote, mapSentence } from '../input.js';

const sentence = { hitokoto: '把一页书读完，把一天过好。', from: '今日摘句', from_who: null, creator: '投稿者', uuid: 'test-uuid' };
const neverFetch = () => { throw new Error('不应该联网'); };

test('template 0 is respected; names and omitted random templates work', () => {
  assert.equal(parseInput({ template: 0 }).template, 0);
  assert.equal(parseInput({ template: 'broadsheet' }).template, 4);
  for (let i = 0; i < 30; i++) assert.ok([0, 1, 2, 3, 4].includes(parseInput({}).template));
});

test('rejects invalid JSON, template, date, scale, fields and unknown keys', () => {
  for (const input of ['{', 'null', '[]', { template: 5 }, { template: null }, { template: '0' }, { date: '2026-02-30' }, { date: '0000-01-01' }, { scale: '2' }, { fields: { quote: 3 } }, { fields: { quote: '' } }, { fields: { titel: 'bad' } }, { texture: NaN }, { timezone: null }, { output: 'file.jpg' }, { grain: 'true' }, { hitokoto: { types: 'd' } }, { hitokoto: { minLength: 60, maxLength: 10 } }, { unknown: 1 }]) assert.throws(() => parseInput(input));
  assert.equal(parseInput({ date: '2024-02-29' }).date, '2024-02-29');
});

test('manual content skips API; dates use configured timezone', async () => {
  const now = new Date('2026-09-12T17:00:00Z');
  const config = await prepareInput({ fields: { quote: '测试。' } }, { fetchImpl: neverFetch, now });
  assert.equal(config.date, '2026-09-13');
  assert.equal(config.source, null);
  assert.equal((await prepareInput({ timezone: 'UTC', fields: { quote: '测试。' } }, { fetchImpl: neverFetch, now })).date, '2026-09-12');
});

test('maps author correctly and respects field overrides on a supplied response', async () => {
  assert.equal(mapSentence(sentence).author, '佚名');
  const config = await prepareInput({ sentence, fields: { author: '自定义作者' }, hitokoto: false }, { fetchImpl: neverFetch });
  assert.equal(config.fields.quote, sentence.hitokoto);
  assert.equal(config.fields.author, '自定义作者');
  assert.equal(config.fields.bookTitle, sentence.from);
  assert.equal(config.source.url, 'https://hitokoto.cn?uuid=test-uuid');
});

test('fetch maps query options and response; no callbacks or script encodings', async () => {
  let requested;
  const fetchImpl = async (url, init) => {
    requested = url;
    assert.ok(init.signal instanceof AbortSignal);
    return { ok: true, json: async () => sentence };
  };
  const config = await prepareInput({ hitokoto: { types: ['d', 'i'], minLength: 12, maxLength: 50 } }, { fetchImpl });
  assert.equal(requested.origin, 'https://v1.hitokoto.cn');
  assert.deepEqual(requested.searchParams.getAll('c'), ['d', 'i']);
  assert.equal(requested.searchParams.get('encode'), 'json');
  assert.equal(requested.searchParams.get('min_length'), '12');
  assert.equal(config.fields.author, '佚名');
});

test('HTTP failure, invalid response and timeout are surfaced instead of fabricated quotes', async () => {
  await assert.rejects(fetchSentence({}, { fetchImpl: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
  await assert.rejects(fetchSentence({}, { fetchImpl: async () => ({ ok: true, json: async () => ({ hitokoto: '' }) }) }), /正文/);
  await assert.rejects(fetchSentence({ timeoutMs: 100 }, { fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } }), /超时/);
  await assert.rejects(prepareInput({ hitokoto: false }), /fields.quote/);
});

test('hitokoto categories default to a/b/c/d/i/k and reject anything else', async () => {
  let requested;
  const fetchImpl = async url => { requested = url; return { ok: true, json: async () => sentence }; };
  await fetchSentence({}, { fetchImpl });
  assert.deepEqual(requested.searchParams.getAll('c'), ['a', 'b', 'c', 'd', 'i', 'k']);
  assert.deepEqual(parseInput({}).apiOptions.types, ['a', 'b', 'c', 'd', 'i', 'k']);
  for (const type of ['e', 'f', 'g', 'h', 'j', 'l', 'z', 'A', '']) assert.throws(() => parseInput({ hitokoto: { types: [type] } }), /hitokoto.types/);
  assert.throws(() => parseInput({ hitokoto: { types: [] } }), /hitokoto.types/);
  assert.deepEqual(parseInput({ hitokoto: { types: ['k', 'a'] } }).apiOptions.types, ['k', 'a']);
});

test('wrapping preserves authored lines and content, including graphemes', () => {
  assert.equal(wrapQuote('第一行\r\n第二行', 0), '第一行\n第二行');
  const text = '风吹过城市的边缘，时间像纸页一样轻轻翻动。我们在写下句子的同时，也在慢慢辨认自己。';
  for (let i = 0; i < 5; i++) {
    const wrapped = wrapQuote(text, i);
    assert.equal(wrapped.replaceAll('\n', ''), text);
    assert.ok(wrapped.split('\n').length <= [2, 2, 3, 4, 3][i]);
    assert.ok(!/\n[，。！？；：]/.test(wrapped));
  }
  assert.ok(wrapQuote('你好👨‍👩‍👧‍👦'.repeat(20), 2).includes('👨‍👩‍👧‍👦'));
});

test('autoWrap can be disabled', async () => {
  const quote = '这是很长的一句话，'.repeat(8);
  const config = await prepareInput({ fields: { quote }, autoWrap: false }, { fetchImpl: neverFetch });
  assert.equal(config.fields.quote, quote);
});
