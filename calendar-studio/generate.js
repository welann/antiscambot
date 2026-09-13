#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { generateImage } from './renderer.js';
import { parseInput } from './input.js';

const help = `纸日图片生成器（Node.js 20+）

node calendar-studio/generate.js '{"template":0,"output":"./today.png"}'
node calendar-studio/generate.js --input calendar-studio/render-request.json
printf '%s' '{}' | node calendar-studio/generate.js --output ./today.png

--input, -i  JSON 文件路径
--output, -o PNG 输出路径（覆盖 JSON 中的 output）
--help, -h   显示帮助

未指定 template 时随机选择 0–4；未指定 fields.quote 时从一言获取。
成功时 stdout 输出一行 JSON；失败时 stderr 输出错误 JSON，退出码为 1。
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(help); return; }
  let inputFile, output, json;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--input', '-i', '--output', '-o'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数`);
      if (arg === '--input' || arg === '-i') inputFile = value; else output = value;
    } else if (arg.startsWith('-')) throw new Error(`未知命令行参数：${arg}`);
    else if (json !== undefined) throw new Error('只能传入一段 JSON 文本');
    else json = arg;
  }
  if (json !== undefined && inputFile) throw new Error('JSON 文本与 --input 不能同时使用');
  if (inputFile) json = await readFile(inputFile, 'utf8');
  else if (json === undefined && !process.stdin.isTTY) {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 100_000) throw new Error('JSON 输入不能超过 100 KB'); chunks.push(chunk); }
    json = Buffer.concat(chunks).toString('utf8');
  }
  let input;
  try { input = JSON.parse(json?.trim() || '{}'); } catch { throw new Error('输入不是有效的 JSON'); }
  const config = parseInput(input);
  // Keep the template selected by validation, so random selection happens once.
  input = { ...input, template: config.template, output: output ?? input.output ?? './calendar.png' };
  const { buffer, ...result } = await generateImage(input);
  process.stdout.write(`${JSON.stringify({ ...result, bytes: buffer.length })}\n`);
}
main().catch(error => { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; });
