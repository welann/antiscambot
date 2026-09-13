import { randomInt } from 'node:crypto';

export const TEMPLATES = ['minimal', 'geometric', 'literary', 'constructivist', 'broadsheet'];
export const FIELD_KEYS = ['month', 'day', 'weekday', 'fullDate', 'weekNo', 'dayOfYear', 'year', 'quote', 'bookTitle', 'author', 'footer', 'issue'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };

export function parseInput(input) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > 100_000) fail('JSON 输入不能超过 100 KB');
    try { input = JSON.parse(input); } catch { fail('输入不是有效的 JSON'); }
  }
  if (!object(input)) fail('输入必须是 JSON 对象');
  const allowed = ['template', 'date', 'timezone', 'fields', 'hitokoto', 'sentence', 'output', 'scale', 'texture', 'grain', 'decorative', 'autoWrap'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail(`未知参数：${key}`);
  const template = input.template === undefined ? randomInt(5) : typeof input.template === 'string' ? TEMPLATES.indexOf(input.template) : input.template;
  if (!Number.isInteger(template) || template < 0 || template > 4) fail('template 必须是 0–4 或模板名称 minimal/geometric/literary/constructivist/broadsheet');
  const scale = input.scale === undefined ? 2 : input.scale;
  if (![1, 2, 3].includes(scale)) fail('scale 必须是数字 1、2 或 3');
  const texture = input.texture === undefined ? 0.25 : input.texture;
  if (typeof texture !== 'number' || !Number.isFinite(texture) || texture < 0 || texture > 1) fail('texture 必须是 0–1 的数字');
  for (const key of ['grain', 'autoWrap']) if (input[key] !== undefined && typeof input[key] !== 'boolean') fail(`${key} 必须是布尔值`);
  if (input.output !== undefined && (typeof input.output !== 'string' || !input.output.trim() || !/\.png$/i.test(input.output))) fail('output 必须是以 .png 结尾的文件路径');
  const timezone = input.timezone === undefined ? 'Asia/Shanghai' : input.timezone;
  if (typeof timezone !== 'string' || !timezone) fail('timezone 必须是 IANA 时区名称');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { fail('timezone 不是有效时区'); }
  if (input.date !== undefined) {
    if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) fail('date 必须是 YYYY-MM-DD');
    const date = new Date(`${input.date}T12:00:00Z`);
    if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== input.date || input.date.startsWith('0000')) fail('date 不是有效日期');
  }
  const fields = input.fields === undefined ? {} : input.fields;
  if (!object(fields)) fail('fields 必须是对象');
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_KEYS.includes(key)) fail(`未知文字字段：${key}`);
    if (typeof value !== 'string' || value.length > (key === 'quote' ? 1200 : 240)) fail(`${key} 必须是长度不超过 ${key === 'quote' ? 1200 : 240} 的字符串`);
    if (!value.trim()) fail(`${key} 不能是空白文字（省略该字段即可使用默认值）`);
  }
  const decorative = input.decorative === undefined ? {} : input.decorative;
  if (!object(decorative)) fail('decorative 必须是对象');
  for (const [key, value] of Object.entries(decorative)) if (typeof value !== 'string' || value.length > 400) fail(`装饰文字 ${key} 必须是长度不超过 400 的字符串`);
  const hitokoto = input.hitokoto === undefined ? true : input.hitokoto;
  if (typeof hitokoto !== 'boolean' && !object(hitokoto)) fail('hitokoto 必须是 true、false 或参数对象');
  const apiOptions = validateApiOptions(object(hitokoto) ? hitokoto : {});
  if (input.sentence !== undefined) mapSentence(input.sentence);
  return { ...input, template, scale, texture, timezone, fields: { ...fields }, decorative: { ...decorative }, hitokoto, apiOptions, autoWrap: input.autoWrap ?? true };
}

function validateApiOptions(options) {
  for (const key of Object.keys(options)) if (!['types', 'minLength', 'maxLength', 'timeoutMs'].includes(key)) fail(`未知一言参数：${key}`);
  const types = options.types ?? ['d', 'i', 'k'];
  if (!Array.isArray(types) || types.some(type => typeof type !== 'string' || !/^[a-l]$/.test(type))) fail('hitokoto.types 必须是 a–l 分类字母组成的数组');
  const minLength = options.minLength ?? 8, maxLength = options.maxLength ?? 60;
  if (![minLength, maxLength].every(n => Number.isInteger(n) && n >= 0 && n <= 1200) || maxLength < minLength) fail('一言长度必须是 0–1200 的整数，且 maxLength ≥ minLength');
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) fail('timeoutMs 必须是 100–60000 的整数');
  return { types, minLength, maxLength, timeoutMs };
}

export function mapSentence(sentence) {
  if (!object(sentence) || typeof sentence.hitokoto !== 'string' || !sentence.hitokoto.trim() || sentence.hitokoto.length > 1200) fail('一言响应缺少有效的 hitokoto 正文');
  for (const key of ['from', 'from_who']) if (sentence[key] != null && (typeof sentence[key] !== 'string' || sentence[key].length > 240)) fail(`一言响应的 ${key} 格式无效`);
  return {
    quote: sentence.hitokoto.trim(),
    bookTitle: sentence.from?.trim() || '今日摘句',
    author: sentence.from_who?.trim() || '佚名',
  };
}

export async function fetchSentence(options = {}, { fetchImpl = globalThis.fetch } = {}) {
  const config = validateApiOptions(options);
  const url = new URL('https://v1.hitokoto.cn/');
  url.searchParams.set('encode', 'json');
  for (const type of config.types) url.searchParams.append('c', type);
  url.searchParams.set('min_length', config.minLength);
  url.searchParams.set('max_length', config.maxLength);
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(config.timeoutMs), headers: { Accept: 'application/json' } });
    if (!response.ok) fail(`一言接口返回 HTTP ${response.status}`);
    const sentence = await response.json();
    mapSentence(sentence);
    return sentence;
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') fail(`一言请求超时（${config.timeoutMs} ms），请重试或在 fields.quote 中提供文字`);
    throw new Error(`获取一言失败：${error.message}`, { cause: error });
  }
}

const graphemes = text => [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)].map(item => item.segment);
const weight = char => /^[\x00-\x7F]+$/.test(char) ? 0.55 : 1;

export function wrapQuote(text, template) {
  text = text.replace(/\r\n?/g, '\n');
  if (text.includes('\n')) return text;
  const chars = graphemes(text);
  const total = chars.reduce((sum, char) => sum + weight(char), 0);
  const count = Math.min([2, 2, 3, 4, 3][template], Math.ceil(total / [24, 24, 20, 18, 20][template]));
  if (count < 2) return text;
  const output = [];
  let rest = chars;
  for (let remaining = count; remaining > 1; remaining--) {
    const target = rest.reduce((sum, char) => sum + weight(char), 0) / remaining;
    let best = 1, score = Infinity, width = 0;
    for (let i = 1; i < rest.length; i++) {
      width += weight(rest[i - 1]);
      let cost = Math.abs(width - target);
      if (/[，。！？；：、,.!?;:]$/.test(rest[i - 1])) cost -= 2;
      if (/^[，。！？；：、,.!?;:）》」』】]/.test(rest[i])) cost += 1000;
      if (/[（《「『【]$/.test(rest[i - 1])) cost += 1000;
      if (/[a-zA-Z0-9]$/.test(rest[i - 1]) && /^[a-zA-Z0-9]/.test(rest[i])) cost += 100;
      if (cost < score) { best = i; score = cost; }
    }
    output.push(rest.slice(0, best).join('').trim());
    rest = rest.slice(best);
  }
  output.push(rest.join('').trim());
  return output.join('\n');
}

export async function prepareInput(input, { fetchImpl, now = new Date() } = {}) {
  const config = parseInput(input);
  let sentence = config.sentence;
  if (!sentence && config.fields.quote === undefined) {
    if (config.hitokoto === false) fail('hitokoto=false 时，请提供 fields.quote 或 sentence');
    sentence = await fetchSentence(config.apiOptions, { fetchImpl });
  }
  const fields = {
    bookTitle: '今日摘句', author: '佚名', footer: 'Read the day. Write the self.', issue: '03',
    ...(sentence ? mapSentence(sentence) : {}), ...config.fields,
  };
  if (config.autoWrap) fields.quote = wrapQuote(fields.quote, config.template);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = type => parts.find(item => item.type === type).value;
  const date = config.date ?? `${part('year')}-${part('month')}-${part('day')}`;
  const source = sentence ? {
    provider: 'hitokoto', id: sentence.id ?? null, uuid: sentence.uuid ?? null,
    url: typeof sentence.uuid === 'string' ? `https://hitokoto.cn?uuid=${encodeURIComponent(sentence.uuid)}` : 'https://hitokoto.cn',
    quote: sentence.hitokoto, from: sentence.from ?? null, author: sentence.from_who ?? null,
  } : null;
  return { ...config, date, fields, source };
}
