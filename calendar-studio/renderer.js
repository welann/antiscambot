import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { prepareInput, TEMPLATES } from './input.js';

/** JSON object or JSON text -> { buffer: Buffer, template, fields, source, ... }.
 * Pass output in JSON to also save the PNG. No server or visible browser needed.
 */
export async function generateImage(input = {}, { fetchImpl } = {}) {
  const config = await prepareInput(input, { fetchImpl });
  const [paper, templates] = await Promise.all([
    readFile(new URL('./assets/paper.png', import.meta.url)),
    readFile(new URL('./templates.js', import.meta.url), 'utf8'),
  ]);
  const launch = { headless: true };
  if (process.env.CALENDAR_BROWSER_PATH) launch.executablePath = process.env.CALENDAR_BROWSER_PATH;
  else if (!existsSync(chromium.executablePath())) launch.channel = 'chrome';
  let browser;
  try { browser = await chromium.launch(launch); }
  catch (error) { throw new Error('无法启动 Chromium。请在 calendar-studio 中执行 npm run install:browser，或设置 CALENDAR_BROWSER_PATH 指向浏览器可执行文件。', { cause: error }); }
  try {
    const page = await browser.newPage({ viewport: { width: 1122, height: 1402 } });
    await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body style="margin:0"><div id="poster"></div></body></html>');
    await page.evaluate(data => { window.CALENDAR_PAPER = data; }, `data:image/png;base64,${paper.toString('base64')}`);
    await page.addScriptTag({ content: templates });
    const result = await page.evaluate(async ({ template, date, fields, texture, grain, decorative, scale }) => {
      const T = window.CalendarTemplates;
      for (const key of Object.keys(decorative)) if (!(key in T.decorativeDefaults[template])) throw new Error(`此模板不支持装饰字段：${key}`);
      const values = { ...T.dateFields(date), ...fields };
      const options = { texture, grain, decorative, scale };
      await document.fonts.ready;
      T.render(document.getElementById('poster'), template, values, options);
      const reducedFields = T.fit(document.getElementById('poster'));
      const blob = await T.createPNG(template, values, options);
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
      });
      return { base64: data.slice(data.indexOf(',') + 1), fields: values, reducedFields };
    }, config);
    const buffer = Buffer.from(result.base64, 'base64');
    let output = null;
    if (config.output) {
      output = resolve(config.output);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, buffer);
    }
    return { buffer, output, template: config.template, templateName: TEMPLATES[config.template], date: config.date, width: 1122 * config.scale, height: 1402 * config.scale, fields: result.fields, source: config.source, reducedFields: result.reducedFields };
  } finally { await browser.close(); }
}
