# Anti-Scam Bot 开发文档

## 项目概述

这是一个基于 Telegram 的反诈骗机器人，用于自动检测并删除群聊中包含敏感关键词的消息。它还可以每天从多个来源频道按最大 ID 间距选择历史消息链接，整理后发送到一个目标频道，并支持将管理员私聊提交的固定格式链接发布为频道超链接。

## 核心功能

### 1. 关键词检测
- **检测范围**：
  - 消息文本 (`text`)
  - 媒体说明/标题 (`caption`)
  - 内联键盘按钮文字 (`button_text`)
  - 内联键盘按钮链接 (`button_url`)
  - 发送者用户名 (`username`)
- **匹配规则**：不区分大小写，支持部分匹配
- **优先级**：按关键词长度降序匹配（优先匹配更长的关键词）

### 2. 消息自动处理
- 自动删除命中关键词的消息
- **独立三段规则**：仅检测群/超级群的新消息和编辑消息；正文或媒体 `caption` 去除首尾空白后，按空白分隔恰好 3 段，第一段为 `@xxxbot` 形式（用户名仅含 ASCII 字母、数字、下划线，以 `bot` 结尾且忽略大小写），后两段为任意非空内容，不限定 `campaign`、`g`、长度或字符集，即自动删除。
- 此规则独立于关键词列表，`/clearkw` 不会关闭；沿用下述“独立详细记录 + 原回复位置简短提示”的删除流程，不扩展到私聊或频道审核。
- 发送删除通知到群聊，包含：
  - 命中关键词或独立规则
  - 发送者信息（@用户名 或 user:ID）
  - 命中位置（消息文本/媒体说明/按钮文字/按钮链接/发送者用户名）
  - 命中内容预览（截断至 120 字符）
  - 必要时附消息预览（截断至 120 字符）
- 删除失败时发送错误通知并提示检查权限
- 删除成功后，先独立发送详细记录（不回复任何帖子，并关闭链接预览），再在被删消息原本回复的帖子下只发送“已删除一条消息”。论坛话题内保留话题位置；没有回复对象或话题的独立消息只发送详细记录。删除失败时回复仍存在的原消息说明原因。

### 3. 关键词管理
| 命令 | 功能 | 权限要求 |
|------|------|----------|
| `/addkw <keyword>` | 添加关键词 | 管理员 |
| `/delkw <keyword>` | 删除关键词 | 管理员 |
| `/clearkw` | 删除全部关键词，持久化并对所有群聊生效 | 管理员 |
| `/keywords` | 查看所有关键词 | 任何人 |

### 4. 权限管理
四种方式定义管理员：
1. **环境变量**：`KEYWORD_ADMIN_IDS=123,456`
2. **文件持久化**：`admins.txt` 存储用户 ID
3. **群管理员**：自动识别群聊中的管理员
4. **首次初始化**：尚无环境变量或文件管理员时，首个使用 `/start` 的用户自动成为全局管理员

关键词列表由所有群聊共享；群管理员修改关键词也会全局生效。`/start` 同时显示当前版本、更新记录和命令帮助。

### 5. 频道历史汇总

- 支持登记多个公开或私有来源频道
- 每天按 `Asia/Shanghai` 时区在 12:00 自动执行
- 每个来源按最新消息 ID 等分为若干区间，每个区间在未抽样的空位中取最远离历史抽样的一个 ID，最多 10 个
- 来源频道有新帖时自动更新最新消息 ID
- 按频道标题分组，将可点击链接整理为一条 HTML 汇总
- 所有来源、目标、运行记录、链接和完整汇总内容存入 SQLite
- 抽样结果是确定性的：相同的已用 ID 集合与最新消息 ID 总是得到相同结果；只保证消息 ID 均匀覆盖，不保证内容主题多样

| 命令 | 功能 | 权限要求 |
|------|------|----------|
| `/addsource <links>` | 添加或重新启用一个或多个来源频道 | 全局管理员私聊 |
| `/sources` | 查看目标、来源和剩余数量 | 全局管理员私聊 |
| `/delsource <编号>` | 停用来源，保留历史去重记录 | 全局管理员私聊 |
| `/settarget <link>` | 设置目标频道 | 全局管理员私聊 |
| `/setsamplesize <数量>` | 设置每个来源的抽样数量（1-100），重启后保留 | 全局管理员私聊 |
| `/digestnow` | 立即发送一次汇总 | 全局管理员私聊 |

`/addsource` 需要来源频道的最新帖子链接，`/settarget` 需要目标频道任意一条帖子的链接。Bot 必须是这些频道的管理员，并且在目标频道拥有发布消息权限。

### 6. 固定格式链接投稿

- 使用 `/setlinktarget <目标频道任意帖子链接>` 设置独立的投稿频道
- 全局管理员在与 Bot 的私聊中直接发送一行或多行固定格式链接，Bot 会以 Telegram HTML 超链接发布到该频道，并显示文章链接预览
- Bot 会检测所有收到的频道新消息和编辑后的消息（包括媒体说明），在拥有编辑权限的频道中直接转换原消息，并保留回复关系；不需要将这些频道设为投稿目标。群组消息不进行链接转换
- 每行格式：`标题 (文章链接) | 原文 (原文链接)`
- 私聊投稿的单次输入过长时，Bot 会在条目之间拆分为多条频道消息；频道内编辑仅支持转换为单条消息的内容
- 支持链接前后的独立附言；同一行的“附言＋#标签＋空格＋标题”会在标签后拆分，附言保持普通文本。没有明确分隔时，请把附言和链接分成两行，避免将附言视为标题
- 无编辑权限、格式有误或转换后超长时保留原消息。频道文本预览优先使用文章链接，是否生成预览仍取决于 Telegram 和目标网页

示例：

```text
“落到美国人手上，是日本民族最大的幸运”，这句话说得对吗？ (https://telegra.ph/落到美国人手上是日本民族最大的幸运这句话说得对吗-08-13) | 原文 (https://www.zhihu.com/question/2068450586501108139/answer/2070592166431347179)
```

投稿目标与每日摘要目标独立保存。Bot 必须是投稿频道管理员，并且拥有发布和编辑消息权限。

带附言的输入：

```text
这篇文章得看看#做市 做市商怎么挂单（期权ver） (https://telegra.ph/做市商怎么挂单期权ver-10-07) | 原文 (https://zhuanlan.zhihu.com/p/2090947232493204386)
```

转换后第一行为普通文本 `这篇文章得看看#做市`，第二行是可点击的 `做市商怎么挂单（期权ver） | 原文`。

## 项目结构

```
.
├── bot.ts                  # 启动入口：读取配置并运行 Bot
├── app/                    # 配置、依赖组装、权限、消息路由、运行生命周期
├── commands/               # keywords.ts / channels.ts / calendar.ts 命令注册
├── moderation/             # rules.ts 纯匹配逻辑 / handler.ts 群消息审核
├── storage/                # 关键词、管理员 TXT 存储及串行原子写入
├── digest/                 # types.ts / repository.ts / service.ts / formatting.ts
├── digest.ts               # 摘要模块兼容导出入口（facade）
├── shared/time.ts          # 时区日期、每日启动补执行判断
├── calendar.ts             # 日历仓储、服务和渲染适配
├── calendar-studio/        # 独立 JS 渲染组件、模板、资源及测试
├── link-submission.ts      # 固定格式链接解析与 Telegram HTML 排版
├── message-handling.ts     # 回复位置、删除通知和频道消息转换
├── tests/                  # 存储、摘要、日历、消息处理及应用路由测试
├── docs/architecture.md    # 模块边界、扩展方法与保留限制
├── dist/                   # TypeScript 编译产物，运行入口为 dist/bot.js
├── package.json            # 依赖与构建、运行、测试脚本
├── tsconfig.json           # 全量编译（含 tests），输出 dist/
├── tsconfig.build.json     # 生产编译，排除 tests 和 calendar-studio
├── Dockerfile              # 多阶段构建，部署 dist/ 与 JS 渲染组件
├── .env.example            # 环境变量示例
├── keywords.txt            # 本地关键词文件及镜像初始化默认值
├── admins.txt              # 本地管理员 ID 文件
├── data/
│   └── antiscambot.sqlite   # 摘要、投稿目标及日历持久化数据库
└── pnpm-lock.yaml          # 依赖锁定文件
```

## 技术栈

- **框架**: [Grammy](https://grammy.dev/) - Telegram Bot 框架
- **语言**: TypeScript 5.9+
- **运行时**: Node.js 22+ (ES Module)
- **数据库**: Node.js 内置 `node:sqlite`
- **定时任务**: node-cron
- **配置**: dotenv 环境变量管理

## 配置文件详解

### package.json 脚本

项目使用 ESM；主要依赖为 Grammy、dotenv、node-cron 和用于日历渲染的 Playwright。

| 命令 | 实际执行 |
| --- | --- |
| `pnpm run build` | `tsc -p tsconfig.build.json`，生产代码输出到 `dist/` |
| `pnpm start` | `node dist/bot.js`，需先构建 |
| `pnpm run typecheck` | `tsc --noEmit`，检查源码与 TS 测试 |
| `pnpm test` | `tsc`，然后依次运行 `dist/tests/*.test.js` 和 `calendar-studio/tests/*.test.js` |

### tsconfig.json 关键配置
- `module`: `nodenext` - 使用 Node.js ESM 模块系统
- `target`: `esnext` - 编译为最新 ECMAScript
- `strict`: `true` - 启用严格类型检查
- `sourceMap`: `true` - 生成 source map
- `rootDir`: `.` / `outDir`: `dist` - 保留模块目录结构，不再向源码旁输出 JS
- `tsconfig.build.json` 继承此配置并排除测试；`calendar-studio` 保留 JS 源码，不参与 TypeScript 编译

### 环境变量 (.env)
```bash
BOT_TOKEN="your_bot_token_here"      # Telegram Bot Token (必需)
KEYWORD_ADMIN_IDS="123,456"          # 全局管理员用户 ID (可选)
KEYWORDS_FILE="./keywords.txt"       # 关键词文件路径
ADMINS_FILE="./admins.txt"           # 管理员文件路径

DIGEST_DB_FILE="./data/antiscambot.sqlite"
DIGEST_CRON="0 12 * * *"
DIGEST_TIMEZONE="Asia/Shanghai"
DIGEST_SAMPLE_SIZE="10"             # 仅用于首次初始化
DIGEST_SEND_MAX_ATTEMPTS="3"      # 每个摘要分段最多发送次数
```

## 布告栏日历

全局管理员在 Bot 私聊中设置目标频道：

```text
/setcalendartarget https://t.me/your_channel/123
```

也支持私有频道帖子链接 `https://t.me/c/频道内部ID/消息ID`。Bot 必须是频道管理员且拥有发布消息权限。

设置成功后立即获取一言、随机选择一款日历模板并发送 PNG，图片说明固定为 `#布告栏`。此后每天 **北京时间 08:00（Asia/Shanghai）** 发送当天的新日历。布告栏目标与摘要、链接投稿目标独立保存。

| 命令 | 用途 |
| --- | --- |
| `/setcalendartarget <帖子链接>` | 设置频道并立即发送今日图片 |
| `/calendarstatus` | 查看频道、发送时间、今日状态及失败原因 |
| `/calendarnow` | 强制重新发送今日图片（当天已发送过也会再发一条） |
| `/stopcalendar` | 停用日历发送，保留历史记录 |

以上命令仅全局管理员私聊可用。自动发送每天每个目标频道最多成功一次；重复设置同一频道或在当天重启不会重复发送。只有手动执行 `/calendarnow` 才会忽略当天已有记录、重新发送一张新图片。首次设置在 08:00 之前时，立即发送的图片计入当天，下一次自动发送为次日 08:00。更换频道会立即向新频道发送当天图片。

配置和记录保存在 `DIGEST_DB_FILE` 数据库的 `calendar_config` / `calendar_deliveries` 表中。Bot 在 08:00 后启动时补发当天遗漏的图片，不补发更早日期。定时任务固定使用东八区，不受摘要模块的 `DIGEST_CRON` 或 `DIGEST_TIMEZONE` 影响。

生成失败、Telegram 明确拒绝时，配置保留，可用 `/calendarnow` 重试；该命令不判断当天是否已发送成功，重复执行会重复发图。如果连接中断导致发送结果不明，Bot 不会自动重发；先检查频道，再在确认未收到时手动补发。失败会写入日志和状态。发送进行中不允许更改目标或停用，以避免图片发往过时频道。

本地首次使用图片功能需要安装浏览器：

```sh
pnpm install
pnpm exec playwright install chromium
pnpm run build
pnpm start
```

也可以设置 `CALENDAR_BROWSER_PATH` 指向现有 Chromium / Chrome 可执行文件。Dockerfile 已切换为 Debian，并安装 Chromium、中文字体及纸纹资源，容器中无需额外安装浏览器。频道图片使用 1122×1402 的 PNG，按 Telegram 图片发送（Telegram 可能压缩图片）。

## 代码架构

### 核心模块

| 模块 | 入口与职责 |
| --- | --- |
| `app/config.ts` / `create-bot.ts` / `services.ts` | `readConfig()` 校验配置；`createBot(config, services)` 注入依赖、注册处理器，不启动网络、存储或调度 |
| `app/runtime.ts` | `runBot()` 加载存储、创建服务、初始化 Bot、安排 cron/启动补执行并管理退出 |
| `app/permissions.ts` / `channels.ts` | `createPermissions()` 统一授权；`resolveManagedChannel()` 校验频道链接及 Bot 发布/编辑权限 |
| `commands/` | `registerKeywordCommands()`、`registerChannelCommands()`、`registerCalendarCommands()`；`handleLinkSubmission()` 处理私聊投稿 |
| `app/messages.ts` | `registerMessageHandlers()` 区分私聊、群消息、编辑消息和频道更新；新频道帖子同时更新来源最新 ID |
| `moderation/` | `collectMessageScanCandidates()`、`findBotTripletMatch()` 等纯匹配函数；`moderateGroupMessage()` 执行群审核，三段规则先于关键词 |
| `storage/` | `KeywordStore`：`load/add/remove/clear/list/find`；`AdminStore`：`load/isGlobal/hasAny/bootstrapFirst`；共享文件工具实现串行队列与原子替换 |
| `digest/` | `DigestRepository` 管理 SQLite；`DigestService` 管理抽样、预留和发送重试；`formatting.ts` 提供链接解析、HTML 转义及分段；`types.ts` 定义接口 |
| `calendar.ts` / `shared/time.ts` | 日历仓储、服务和渲染适配保留在一起；日期与补执行判断复用 `getLocalDate()`、`shouldRunDailyCatchUp()` |
| `link-submission.ts` / `message-handling.ts` | `formatLinkSubmissionMessage()` 保留附言并生成 HTML；`convertChannelLinks()` 原位编辑，`deleteWithNotice()` 处理删除通知及回复位置 |
| `app/result-messages.ts` / `release-notes.ts` | 摘要结果提示，以及 `/start` 展示的版本和更新记录 |

摘要连接启用 WAL、外键、`busy_timeout` 和 `synchronous=FULL`。发送前预留本次抽样 ID，重启后不会再次抽取。发送失败默认按 1 秒、2 秒间隔重试，总共尝试 3 次；`DIGEST_SEND_MAX_ATTEMPTS` 可设为 1-10。后续 `/digestnow` 优先重发失败分段，再进行新抽样。`DIGEST_SAMPLE_SIZE` 只决定首次默认值，之后以 `/setsamplesize` 写入 SQLite 的值为准。

### 状态与生命周期

不再由 `bot.ts` 持有可变全局状态。`runBot()` 为每次运行创建一组 store、repository 和 service，经 `BotServices` 注入处理器；Bot ID 从初始化后的 `bot.botInfo.id` 获取。关键词仍是所有群共用的一份列表，不是按群隔离。

关键词索引、管理员集合及文件队列封装在各自 store 中，写盘成功后才更新内存；并发 `/start` 在同一 `AdminStore` 内只有一人能完成首次初始化。收到 SIGINT/SIGTERM 后停止轮询，退出清理销毁定时任务、等待已跟踪任务及日历空闲，再关闭两个 SQLite 连接。文件队列不提供跨实例锁。

模块边界、扩展步骤和保留限制见 [架构说明](docs/architecture.md)。

## 更新记录

版本记录位于 `app/release-notes.ts` 的 `RELEASE_NOTES` 数组，`LOGIC_VERSION` 取第一条日期，`/start` 默认展示最近 10 条。目前版本仍为 `2026-11-11`；模块拆分与 `dist/` 构建调整不另造业务版本，也不要求转换现有 TXT 或 SQLite 数据。

| 版本日期 | 更新内容 |
|----------|----------|
| 2026-11-11 | 新增群/超级群新消息及编辑消息的独立三段自动删除规则：正文或 caption 去除首尾空白后按空白分隔，首段为 `@xxxbot`，后两段任意非空；不受 `/clearkw` 影响，沿用独立详细记录及原回复位置简短提示，不审核私聊/频道。每日摘要改为按消息 ID 等分区间抽取，每个区间取最远离历史抽样的空位 |
| 2026-10-08 | 删除详细记录独立发送，原回复位置只显示简短提示；所有可编辑频道转换链接并保留附言；增加 `/clearkw` |
| 2026-09-13 | 新增布告栏日历，设置频道后立即发送，每天北京时间 08:00 自动发图 |
| 2026-08-18 | 投稿频道内的固定格式链接可直接编辑原消息，保留回复关系 |
| 2026-08-13 | 新增固定格式链接投稿，可发布带预览的频道超链接 |
| 2026-08-02 | 摘要发送自动重试，并支持命令调整每日抽样数量 |
| 2026-07-23 | 新增多频道历史随机链接汇总与 SQLite 持久化 |
| 2026-02-28 | 新增发送者用户名关键字检测 |
| 2026-02-05 | 新增编辑消息检测：编辑后命中关键词也会删除 |
| 2026-02-01 | 新增 inline keyboard 按钮文字/链接关键字检测 |
| 2026-01-28 | 首次运行可用 /start 初始化全局管理员（admins.txt） |
| 2026-01-27 | 关键词管理（keywords.txt）+ 群消息命中删除提示 |

## 开发命令

```bash
# 安装依赖
pnpm install

# 生产编译：输出 dist/，不编译 tests/
pnpm run build

# 运行 Bot：node dist/bot.js
pnpm start

# 检查源码及 TS 测试，不生成文件
pnpm run typecheck

# 编译至 dist/，运行 TS 测试及日历组件的 *.test.js
pnpm test
```

`pnpm test` 不包含 `calendar-studio/tests/render.integration.js` 浏览器渲染集成脚本。生产部署需要完整 `dist/` 模块目录，以及其同级的 `calendar-studio` JS 渲染组件和资源，不能只复制 `dist/bot.js`；运行数据路径仍相对于进程工作目录或使用环境变量指定的绝对路径。

## Docker 部署

Docker 构建阶段使用 `tsconfig.build.json`，运行阶段复制完整 `dist/`，以 `node dist/bot.js` 启动；`calendar-studio` 的渲染器、输入处理、模板 JS 和纸纹资源单独复制，不重写为 TypeScript。

构建镜像：

```bash
docker build -t antiscambot .
```

首次启动前创建持久化数据目录：

```bash
mkdir -p data
```

镜像会内置构建时的 `keywords.txt`。首次连接一个尚未初始化的 `data/` 目录时，入口脚本会自动将它复制为持久化文件；如果目录中已经存在非空文件，则保留现有数据。`admins.txt` 不会进入镜像，首次运行时由 Bot 创建，并可通过 `/start` 初始化第一个全局管理员。

启动机器人：

```bash
docker run -d \
  --name antiscambot \
  --restart unless-stopped \
  --env-file .env \
  -v "$(pwd)/data:/app/data" \
  antiscambot
```

查看运行日志：

```bash
docker logs -f antiscambot
```

镜像不会包含 `.env`、`admins.txt` 或 SQLite 数据库，只包含用于首次初始化的默认 `keywords.txt`。`BOT_TOKEN` 通过 `--env-file` 注入；实际运行中的关键词、管理员配置和 `antiscambot.sqlite` 都保存在宿主机的 `data/` 目录中。初始化完成后会生成 `.defaults-initialized` 标记，后续容器重建或重启不会用镜像默认值覆盖运行数据。

SQLite 主库是当前唯一恢复来源，没有额外的滚动或远程备份。需要防范宿主机磁盘损坏时，应在外部定期备份整个 `data/` 目录。

### 摘要配置示例

在 Bot 私聊中执行：

```text
/addsource https://t.me/source_one/1234
/addsource https://t.me/c/1234567890/5678
/settarget https://t.me/digest_channel/1
/sources
/digestnow
```

Bot 只根据消息 ID 生成随机链接，不会读取真实历史内容或日期。频道中的删除消息、服务消息或空号可能生成无法打开的链接；这些 ID 仍会写入 SQLite，并且不会再次抽取。

## 部署注意事项

1. **必需权限**: 机器人在群里需要 "删除消息" 的管理员权限
2. **隐私模式**: 需要在 @BotFather 中关闭 Privacy Mode，否则无法接收群消息
3. **频道权限**: 来源频道中 Bot 必须是管理员，目标频道还必须允许 Bot 发布消息
4. **文件持久化**: `keywords.txt`、`admins.txt` 和 SQLite 数据目录需要写入权限
5. **单实例**: 不要让多个 Bot 容器同时写入同一个 SQLite 文件
6. **环境变量**: 生产环境建议使用更安全的方式管理 BOT_TOKEN
