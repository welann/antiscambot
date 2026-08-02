# Anti-Scam Bot 开发文档

## 项目概述

这是一个基于 Telegram 的反诈骗机器人，用于自动检测并删除群聊中包含敏感关键词的消息。它还可以每天从多个来源频道随机选择历史消息链接，整理后发送到一个目标频道，并使用 SQLite 永久保存配置和去重记录。

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
- 发送删除通知到群聊，包含：
  - 命中关键词
  - 发送者信息（@用户名 或 user:ID）
  - 命中位置（消息文本/媒体说明/按钮文字/按钮链接/发送者用户名）
  - 命中内容预览（截断至 120 字符）
  - 完整消息预览
- 删除失败时发送错误通知并提示检查权限

### 3. 关键词管理
| 命令 | 功能 | 权限要求 |
|------|------|----------|
| `/addkw <keyword>` | 添加关键词 | 管理员 |
| `/delkw <keyword>` | 删除关键词 | 管理员 |
| `/keywords` | 查看所有关键词 | 任何人 |

### 4. 权限管理
四种方式定义管理员：
1. **环境变量**：`KEYWORD_ADMIN_IDS=123,456`
2. **文件持久化**：`admins.txt` 存储用户 ID
3. **群管理员**：自动识别群聊中的管理员
4. **首次初始化**：首个使用 `/start` 的用户自动成为全局管理员

### 5. 频道历史随机汇总

- 支持登记多个公开或私有来源频道
- 每天按 `Asia/Shanghai` 时区在 12:00 自动执行
- 每个来源随机选择最多 10 个从未发送过的消息 ID
- 来源频道有新帖时自动更新最新消息 ID
- 按频道标题分组，将可点击链接整理为一条 HTML 汇总
- 所有来源、目标、运行记录、链接和完整汇总内容存入 SQLite

| 命令 | 功能 | 权限要求 |
|------|------|----------|
| `/addsource <links>` | 添加或重新启用一个或多个来源频道 | 全局管理员私聊 |
| `/sources` | 查看目标、来源和剩余数量 | 全局管理员私聊 |
| `/delsource <编号>` | 停用来源，保留历史去重记录 | 全局管理员私聊 |
| `/settarget <link>` | 设置目标频道 | 全局管理员私聊 |
| `/digestnow` | 立即发送一次汇总 | 全局管理员私聊 |

`/addsource` 需要来源频道的最新帖子链接，`/settarget` 需要目标频道任意一条帖子的链接。Bot 必须是这些频道的管理员，并且在目标频道拥有发布消息权限。

## 项目结构

```
.
├── bot.ts              # 主程序源代码 (TypeScript)
├── digest.ts           # SQLite、抽样、排版和摘要运行逻辑
├── tests/              # 摘要功能自动化测试
├── bot.js              # 编译后的 JavaScript
├── package.json        # 项目依赖配置
├── tsconfig.json       # TypeScript 编译配置
├── .env.example        # 环境变量示例
├── keywords.txt        # 关键词持久化存储
├── admins.txt          # 管理员 ID 持久化存储
├── data/
│   └── antiscambot.sqlite # 频道摘要持久化数据库
└── pnpm-lock.yaml      # 依赖锁定文件
```

## 技术栈

- **框架**: [Grammy](https://grammy.dev/) - Telegram Bot 框架
- **语言**: TypeScript 5.9+
- **运行时**: Node.js 22+ (ES Module)
- **数据库**: Node.js 内置 `node:sqlite`
- **定时任务**: node-cron
- **配置**: dotenv 环境变量管理

## 配置文件详解

### package.json
```json
{
  "type": "module",
  "dependencies": {
    "dotenv": "^17.2.3",
    "grammy": "^1.39.3",
    "node-cron": "^4.6.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3"
  }
}
```

### tsconfig.json 关键配置
- `module`: `nodenext` - 使用 Node.js ESM 模块系统
- `target`: `esnext` - 编译为最新 ECMAScript
- `strict`: `true` - 启用严格类型检查
- `sourceMap`: `true` - 生成 source map
- `declaration`: `true` - 生成 .d.ts 声明文件

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

## 代码架构

### 数据类型定义
```typescript
type ReleaseNote = { version: string; summary: string };
type KeywordEntry = { canonical: string; raw: string };
type MessageMatchSource = "text" | "caption" | "button_text" | "button_url" | "username";
type ScanCandidate = { source: MessageMatchSource; value: string };
```

### 核心模块

#### 1. 文件操作模块
- `ensureKeywordsFile()` / `ensureAdminsFile()` - 确保文件存在
- `loadKeywordsFromDisk()` / `loadAdminsFromDisk()` - 从磁盘加载数据
- `queueKeywordFileOp()` / `queueAdminFileOp()` - 文件操作队列（防竞态）

#### 2. 关键词管理模块
- `normalizeKeyword()` - 规范化关键词（trim）
- `canonicalizeKeyword()` - 标准化关键词（小写）
- `rebuildKeywordEntries()` - 重建关键词索引
- `addKeywordFromUserInput()` - 添加关键词
- `removeKeywordFromUserInput()` - 删除关键词
- `getAllKeywords()` - 获取所有关键词
- `findMatchedKeyword()` - 查找匹配的关键词

#### 3. 消息扫描模块
- `collectMessageScanCandidates()` - 收集消息中所有待检测内容
- `findMatchedKeywordInCandidates()` - 在候选内容中查找匹配
- `describeMatchSource()` - 描述命中位置（中文）
- `buildMessagePreview()` - 构建消息预览
- `truncateForNotice()` - 截断文本用于通知

#### 4. 权限管理模块
- `isGlobalKeywordAdmin()` - 检查是否为全局管理员
- `canManageKeywords()` - 检查是否有权限管理关键词
- `hasAnyGlobalAdmins()` - 检查是否存在任何全局管理员
- `bootstrapFirstAdminIfNeeded()` - 初始化首个管理员

#### 5. 频道摘要模块

- `DigestRepository` - SQLite schema、迁移、事务及持久化
- `DigestService` - 永久去重抽样、消息预留和发送状态管理
- `parseTelegramMessageLink()` - 解析公开/私有频道消息链接
- `formatDigestChunks()` - HTML 分组排版和超长拆分
- `shouldRunDailyCatchUp()` - 定时执行与启动补执行判断

数据库启用 WAL、外键、`busy_timeout` 和 `synchronous=FULL`。Bot 在调用 Telegram 发送前会先预留随机 ID，因此即使发送时重启，也不会在以后重复抽取这些 ID。每个摘要分段发送失败时会按 1 秒、2 秒的间隔自动重试，默认总共尝试 3 次；可通过 `DIGEST_SEND_MAX_ATTEMPTS`（1-10）调整。若全部失败，下一次 `/digestnow` 会优先重发已保留的失败摘要，再进行新的抽样。`DIGEST_SAMPLE_SIZE` 仅决定首次初始化的默认值；之后使用 `/setsamplesize` 修改的值会写入 SQLite，并在重启后保留。

#### 6. Bot 命令处理器
- `/start` - 启动提示，首次运行可初始化管理员
- `/addkw` - 添加关键词
- `/delkw` - 删除关键词
- `/keywords` - 列出所有关键词
- `/addsource` / `/delsource` / `/sources` - 管理摘要来源
- `/settarget` - 设置摘要目标
- `/setsamplesize <数量>` - 设置每个来源频道每日抽样数量（1-100）
- `/digestnow` - 手动执行摘要

#### 7. 消息处理器
- 监听所有消息，过滤非群聊消息
- 排除 Bot 自身消息和命令消息
- 扫描并处理命中关键词的消息
- 监听来源频道的 `channel_post` 并更新最新消息 ID

### 全局状态
```typescript
const keywordMap = new Map<string, string>();     // 关键词映射 (canonical -> raw)
let keywordEntries: KeywordEntry[] = [];          // 排序后的关键词列表
const persistedAdminIds = new Set<number>();      // 持久化管理员 ID
let keywordFileQueue: Promise<unknown> = Promise.resolve();  // 关键词文件操作队列
let adminFileQueue: Promise<unknown> = Promise.resolve();    // 管理员文件操作队列
let BOT_ID: number | null = null;                 // Bot 自身 ID
```

## 更新记录

版本记录存储在代码中的 `RELEASE_NOTES` 数组：

| 版本 | 日期 | 更新内容 |
|------|------|----------|
| 2026-08-02 | 摘要发送自动重试，并支持命令调整每日抽样数量 |
| 2026-07-23 | 新增多频道历史随机链接汇总与 SQLite 持久化 |
| 2026-02-28 | 新增发送者用户名关键字检测 |
| 2026-02-01 | 新增 inline keyboard 按钮文字/链接关键字检测 |
| 2026-01-28 | 首次运行可用 /start 初始化全局管理员（admins.txt） |
| 2026-01-27 | 关键词管理（keywords.txt）+ 群消息命中删除提示 |

## 开发命令

```bash
# 安装依赖
pnpm install

# 编译 TypeScript
pnpm run build

# 运行 Bot
pnpm start

# 运行自动化测试
pnpm test
```

## Docker 部署

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
