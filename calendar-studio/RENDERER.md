# JS 图片生成程序

程序直接复用现有五套 HTML/CSS + SVG 模板和纸纹，以无头 Chromium 渲染 PNG。无需打开编辑器或启动 HTTP 服务。

## 安装一次

需要 Node.js 20 或更高版本。在 `calendar-studio` 目录执行：

```sh
npm ci
npm run install:browser
```

当前工作区已安装 JS 依赖，也已用本机浏览器实测运行。如果没有 Playwright 配套 Chromium，程序会尝试使用本机 Chrome。也可以用环境变量 `CALENDAR_BROWSER_PATH` 指定浏览器可执行文件。

Linux 部署时可用 `npx playwright install --with-deps chromium` 安装浏览器及系统依赖；另外安装中文字体（如 Noto Serif CJK / Noto Sans CJK），避免中文字形缺失。模板的西文系统字体回退及跨平台差异见 README。

## 命令行

以下命令从项目根目录执行。

### 自动获取一言，随机选择模板

```sh
node calendar-studio/generate.js '{"output":"./today.png"}'
```

### 指定模板和日期

```sh
node calendar-studio/generate.js '{"template":0,"date":"2026-09-13","output":"./today.png"}'
```

### 从 JSON 文件读取

```sh
node calendar-studio/generate.js --input calendar-studio/render-request.json
node calendar-studio/generate.js --input calendar-studio/render-manual.json
```

### 通过管道传 JSON

```sh
printf '%s' '{"template":"literary","scale":3}' | node calendar-studio/generate.js --output ./today.png
```

`--output` / `-o` 覆盖 JSON 中的路径。路径相对于调用程序时的工作目录；程序会创建不存在的输出目录，覆盖已有同名 PNG。CLI 未指定输出时保存为当前目录的 `calendar.png`。

成功时 stdout 只输出一行 JSON，包含图片绝对路径、实际使用的模板、尺寸、最终文字和来源信息。失败时 stderr 输出 `{"error":"..."}`，退出码为 1，调用方可据此判断是否成功。

## JSON 参数

```json
{
  "template": "geometric",
  "date": "2026-09-13",
  "timezone": "Asia/Shanghai",
  "fields": {
    "author": "自定义作者",
    "footer": "Read the day."
  },
  "hitokoto": {
    "types": ["d", "i", "k"],
    "minLength": 8,
    "maxLength": 60,
    "timeoutMs": 10000
  },
  "autoWrap": true,
  "scale": 2,
  "texture": 0.25,
  "grain": true,
  "output": "./today.png"
}
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `template` | 随机 | 数字 0–4 或下表名称；显式填写 0 会正确选择第一款 |
| `date` | 今天 | `YYYY-MM-DD`；自动带出月、日、星期、周数、年内天数 |
| `timezone` | `Asia/Shanghai` | 仅用于判断默认的“今天”；指定 date 后不会再换算日期 |
| `fields` | 自动生成 | 直接覆盖模板文字，字段与编辑器相同，详见 README |
| `hitokoto` | `true` | `true` / 参数对象：正文缺失时请求一言；`false`：完全禁止自动请求 |
| `sentence` | 无 | 可选，直接传入已经获取的一言原始响应对象，无需联网 |
| `autoWrap` | `true` | 根据模板给单行摘句分行；已有换行保持不变，填 false 可关闭 |
| `scale` | `2` | 1 = 1122×1402；2 = 2244×2804；3 = 3366×4206 |
| `texture` | `0.25` | 纸纹强度，0–1（注意：CLI 不使用编辑器配置里的 0–70 百分比） |
| `grain` | `true` | 启用墨色颗粒 |
| `decorative` | 模板默认值 | 当前模板的装饰小字覆盖对象，键见 `CalendarTemplates.decorativeDefaults` |
| `output` | CLI: `./calendar.png` | PNG 文件路径；JS 函数不传时只返回 Buffer |

| 编号 | 名称 | 对应版式 |
| --- | --- | --- |
| 0 | `minimal` | 留白日历 |
| 1 | `geometric` | 几何拼贴 |
| 2 | `literary` | 文学书页 |
| 3 | `constructivist` | 构成主义 |
| 4 | `broadsheet` | 古典报刊 |

未知参数、错误日期、超出范围的模板编号等都会报错。`fields` 的值使用非空字符串：需要默认值时省略字段，避免在最终图片中留下占位符。

### 文字来源与覆盖规则

1. 有 `sentence` 时使用传入的一言响应。
2. 没有 `sentence` 也没有 `fields.quote` 时，从一言获取；如果 `hitokoto:false` 则报错。
3. 最后使用 `fields` 覆盖对应文字。因此仅填写 `fields.author` 仍会自动取句，填写 `fields.quote` 则完全不请求接口。
4. 自动日期与文字合并后渲染。`fields.weekday`、`fields.month` 等可以覆盖自动生成的日期文字。

接口映射为：`hitokoto` → `quote`，`from` → `bookTitle`，`from_who` → `author`。缺少作者时使用“佚名”，不会使用投稿者 `creator`。手动摘句没有出处时使用“今日摘句”。

自动请求使用 `https://v1.hitokoto.cn/`，JSON 编码；默认分类为文学 d、诗词 i、哲学 k。`types:[]` 不添加分类筛选。可选类型与参数定义见[一言语句接口文档](https://developer.hitokoto.cn/sentence/)。官方全球接口限制为 2 QPS；批量调用时请由调用方限速，程序不做自动重试，也不会在请求失败时捏造摘句。

结果的 `source` 保留原始句子、出处、作者、ID、UUID 和一言详情链接。自填摘句且未提供 sentence 时 `source` 为 null。显式提供 sentence 后再覆盖 fields 时，source 记录的仍是原始来源，fields 记录实际印制内容。

程序请求配置与编辑器的“保存配置”JSON是不同格式；旧配置中的 `fields` 可以原样放到程序配置的 `fields` 中。

## JS 函数调用

```js
import { generateImage } from './calendar-studio/renderer.js';

// 接受对象，也接受 JSON 字符串。
const result = await generateImage({
  template: 2,
  date: '2026-09-13',
  hitokoto: { types: ['d', 'i'], maxLength: 50 },
  output: './today.png'
});

console.log(result.output);       // 已保存的 PNG 绝对路径
console.log(result.template);     // 实际选择的 0–4
console.log(result.fields);       // 最终填充文字
console.log(result.source?.url);  // 一言详情链接
// result.buffer 是 PNG Buffer，可直接传给机器人、HTTP 响应或对象存储。
```

如果不需要落盘：

```js
const { buffer } = await generateImage(JSON.stringify({
  fields: {
    quote: '把一页书读完，\n把一天过好。',
    author: '匿名'
  }
}));
```

已有一言响应时：

```js
const { buffer } = await generateImage({
  sentence: {
    hitokoto: '你已经拿到了这句文字。',
    from: '你的来源',
    from_who: null
  },
  template: 'minimal'
});
```

每次调用都会启动并关闭一个无头浏览器，失败时也会释放浏览器。结果中的 `reducedFields` 列出自动缩小较多的字段；内容长到无法容纳时直接报错，不输出截断图片。

## 验证

```sh
npm test --prefix calendar-studio
npm run test:render --prefix calendar-studio
```

单元测试覆盖参数验证、随机模板范围、时区、接口字段映射、覆盖优先级、错误响应和换行。集成测试实际渲染五款模板、三种尺寸、校验 PNG 文件头和落盘结果，并验证 stdin CLI 和错误退出码。测试不依赖一言联网，真实接口已另外实测，示例图片为 `examples/hitokoto-cli.png`。
