# 纸日 · 文学日历模板

五套根据参考图重建的 HTML/CSS 日历模板，文字为 HTML，几何图形和做旧装饰为 SVG。纸纹来自提供的第六张图片。图片中的占位文字被转换为可填充字段，图片本身没有作为整张背景使用。

## 通过 JS / JSON 生成图片

现已支持命令行和 JS 函数调用，传 JSON 即可得到 PNG。未指定模板时随机选择；未填写摘句时从一言接口自动获取。安装、参数及代码示例见 [JS 程序使用说明](RENDERER.md)。

```sh
node calendar-studio/generate.js '{"output":"./today.png"}'
```

以上命令从项目根目录执行，首次使用先按 RENDERER.md 安装依赖。

## 直接使用

1. 用 Chrome 或 Edge 打开本目录的 `index.html`，无需安装依赖、联网或启动服务器。
2. 选择版式、日期，填写摘句、出处、作者和页脚。日期会自动计算星期、ISO 周数和年内天数；展开「自定义日期文字」可逐项覆盖。
3. 摘句中的换行就是画面上的分行。留空显示 `[MONTH]`、`[DAY]` 等占位符；「查看占位符」临时预览空白模板，不会清除草稿。
4. 调整纸纹深浅，选择导出分辨率，点击「导出 PNG」。导出使用当前模式；占位符预览时导出的也是占位符。

支持 1122 × 1402、2244 × 2804、3366 × 4206 三档 PNG。基准尺寸沿用参考图，比例约为 4:5。导出的图片只包含日历。

「保存配置」下载 JSON，可用「载入配置」恢复全部文字、模板选择、纸纹和装饰小字；草稿也自动存于浏览器本地。「导出 HTML」生成包含纸纹的独立静态网页，可离线查看或打印。若要以后继续编辑，请同时保存 JSON。

## 文件

- `index.html` / `studio.css` / `studio.js`：完整编辑器。
- `templates.js`：五种 HTML/CSS + SVG 模板、字段替换、自动适配、PNG 导出及日期计算。
- `templates/01-minimal.html`：留白日历，对应图 1。
- `templates/02-geometric.html`：几何拼贴，对应图 2。
- `templates/03-literary.html`：文学书页，对应图 3。
- `templates/04-constructivist.html`：构成主义，对应图 4。
- `templates/05-broadsheet.html`：古典报刊，对应图 5。
- `assets/paper.png`：提供的原始纸纹。
- `assets/paper.js`：同一纸纹的内嵌数据版本，确保离线导出不受跨域资源影响。
- `examples/`：五款实际导出的 PNG，以及编辑器截图。
- `example-config.json`：可导入编辑器的示例配置。

独立模板文件共用上一级的脚本和纹理，分发时保留整个目录。每个模板 HTML 的 `template-data` JSON 中，`fields` 可直接填写下列字段，修改后重新打开即可渲染；也可点击「打开编辑器」交互填写。

## 字段

| 字段 | 空白占位符 | 含义 / 示例 |
| --- | --- | --- |
| `month` | `[MONTH]` | SEPTEMBER，可改成九月 |
| `day` | `[DAY]` | 13 |
| `weekday` | `[WEEKDAY]` | 星期日 |
| `fullDate` | `[FULL DATE]` | 2026 年 9 月 13 日 |
| `weekNo` | `[WEEK NO]` | 37，ISO 8601 周数 |
| `dayOfYear` | `[DAY OF YEAR]` | 256 / 365 |
| `year` | `[YEAR]` | 2026，几何拼贴右上角 |
| `quote` | `[QUOTE LINE 1]` 等 | 用 `\n` 分行；空白模板分别显示 2 / 2 / 3 / 4 / 3 行 |
| `bookTitle` | `[BOOK TITLE]` | 《今日摘句》，书名号可自行填写 |
| `author` | `[AUTHOR]` | 匿名 |
| `footer` | `[FOOTER]` | Read the day. Write the self. |
| `issue` | `[NO.]` | 03，报刊版式的期号 |

非占位符的标语、小字默认保留参考版式的内容，可通过「编辑装饰小字」修改。年份、期号只在对应版式出现；切换模板保留所有字段。

## 在自己的网页中复用

按顺序引入 `assets/paper.js` 和 `templates.js`，容器原始尺寸为 1122 × 1402，不要在调用 `render()` 前给容器施加 CSS 缩放。页面加载字体后渲染：

```html
<div id="poster"></div>
<script src="assets/paper.js"></script>
<script src="templates.js"></script>
<script>
(async () => {
  await document.fonts.ready;
  const fields = {
    ...CalendarTemplates.dateFields('2026-09-13'),
    quote: '把一页书读完，\n把一天过好。',
    bookTitle: '《今日摘句》',
    author: '匿名',
    footer: 'Read the day.',
    issue: '03'
  };
  const template = 2; // 0–4，与五张参考图顺序一致
  const options = { texture: 0.25, scale: 2 };
  CalendarTemplates.render(document.getElementById('poster'), template, fields, options);

  // 在需要导出时调用，返回 PNG Blob。
  const blob = await CalendarTemplates.createPNG(template, fields, options);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'calendar.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
})();
</script>
```

`createHTML(template, fields, options)` 返回含内嵌纸纹的完整静态 HTML 字符串。`options.decorative` 可以覆盖当前模板的装饰文字；可用键见 `CalendarTemplates.decorativeDefaults[template]`。`options.grain: false` 可关闭墨色颗粒。

文字始终按纯文本处理，不执行填写内容中的 HTML。过长的文字会自动缩小，并在编辑器提醒；达到字号下限仍放不下时，PNG 导出会提示减少文字或增加换行，避免悄悄截断。

## 排版与兼容性

模板重建了参考图的构图和装饰。使用本机 Times New Roman / 宋体衬线及 Impact 窄体，参考图未提供原字体，因此字形并非逐像素复刻。第 4 款的混凝土面板与墨色颗粒是 SVG 程序纹理。未附带商业字体文件；换一台电脑时，字体回退可能改变字形和最终字号。在同一台电脑导出 PNG 可固定视觉结果。

PNG 使用浏览器的 SVG foreignObject + Canvas 渲染，无远程截图服务。已在本机 Chromium 中验证；建议使用 Chrome / Edge。其他浏览器的字体和 foreignObject 行为可能不同。

如需通过本机服务预览，在此目录执行：

```sh
python3 -m http.server 8873 --bind 127.0.0.1
```

然后访问 `http://127.0.0.1:8873`。
