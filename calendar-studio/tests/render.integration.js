import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateImage } from '../renderer.js';

const fields = { quote: '风吹过城市的边缘，时间像纸页一样轻轻翻动。\n我们在写下句子的同时，也在慢慢辨认自己。', author: '匿名', bookTitle: '《今日摘句》' };
function png(buffer, width, height) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(buffer.readUInt32BE(16), width);
  assert.equal(buffer.readUInt32BE(20), height);
  assert.ok(buffer.length > 10000);
}

test('renders all five templates, text injection as literal content, date metadata and 3 scales', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-days-render-'));
  try {
    for (let template = 0; template < 5; template++) {
      const scale = template % 3 + 1;
      const output = join(dir, 'nested', `${template}.png`);
      const result = await generateImage({ template, fields, date: '2024-02-29', output, scale, texture: 0.15, hitokoto: false });
      png(result.buffer, 1122 * scale, 1402 * scale);
      assert.equal(result.template, template);
      assert.equal(result.fields.dayOfYear, '60 / 366');
      assert.deepEqual(await readFile(output), result.buffer);
    }
    const quote = '<script>throw new Error("bad")</script>\n保留文本';
    const safe = await generateImage({ fields: { quote }, scale: 1 });
    assert.equal(safe.fields.quote, quote);
    png(safe.buffer, 1122, 1402);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI accepts stdin JSON, writes PNG, reports chosen template; invalid input exits nonzero', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-days-cli-'));
  const cli = (input, args = []) => new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL('../generate.js', import.meta.url)), ...args], { cwd: dir });
    let stdout = '', stderr = '';
    process.stdout.on('data', data => { stdout += data; });
    process.stderr.on('data', data => { stderr += data; });
    process.on('error', reject);process.on('close', code => resolve({ stdout, stderr, code }));process.stdin.end(input);
  });
  try {
    const good = await cli(JSON.stringify({ fields, scale: 1 }));
    assert.equal(good.code, 0, good.stderr);
    const data = JSON.parse(good.stdout);
    assert.ok(data.template >= 0 && data.template < 5);
    png(await readFile(data.output), 1122, 1402);
    const bad = await cli('{"template":8}');
    assert.equal(bad.code, 1);
    assert.equal(bad.stdout, '');
    assert.match(JSON.parse(bad.stderr).error, /template/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
