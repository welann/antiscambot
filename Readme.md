# Anti-Scam Bot 开发文档

## 项目概述

这是一个基于 Telegram 的反诈骗机器人，用于自动检测并删除群聊中包含敏感关键词的消息。支持检测消息文本、媒体说明、内联键盘按钮文字及链接，以及发送者用户名。

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
三种方式定义管理员：
1. **环境变量**：`KEYWORD_ADMIN_IDS=123,456`
2. **文件持久化**：`admins.txt` 存储用户 ID
3. **群管理员**：自动识别群聊中的管理员
4. **首次初始化**：首个使用 `/start` 的用户自动成为全局管理员

## 项目结构

```
.
├── bot.ts              # 主程序源代码 (TypeScript)
├── bot.js              # 编译后的 JavaScript
├── bot.d.ts            # TypeScript 声明文件
├── package.json        # 项目依赖配置
├── tsconfig.json       # TypeScript 编译配置
├── .env                # 环境变量 (BOT_TOKEN)
├── keywords.txt        # 关键词持久化存储
├── admins.txt          # 管理员 ID 持久化存储
└── pnpm-lock.yaml      # 依赖锁定文件
```

## 技术栈

- **框架**: [Grammy](https://grammy.dev/) - Telegram Bot 框架
- **语言**: TypeScript 5.9+
- **运行时**: Node.js (ES Module)
- **配置**: dotenv 环境变量管理

## 配置文件详解

### package.json
```json
{
  "type": "module",
  "dependencies": {
    "dotenv": "^17.2.3",
    "grammy": "^1.39.3"
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
KEYWORD_ADMIN_IDS="123,456"           # 全局管理员用户 ID (可选)
KEYWORDS_FILE="./keywords.txt"        # 关键词文件路径 (默认)
ADMINS_FILE="./admins.txt"            # 管理员文件路径 (默认)
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

#### 5. Bot 命令处理器
- `/start` - 启动提示，首次运行可初始化管理员
- `/addkw` - 添加关键词
- `/delkw` - 删除关键词
- `/keywords` - 列出所有关键词

#### 6. 消息处理器
- 监听所有消息，过滤非群聊消息
- 排除 Bot 自身消息和命令消息
- 扫描并处理命中关键词的消息

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
| 2026-02-28 | 新增发送者用户名关键字检测 |
| 2026-02-01 | 新增 inline keyboard 按钮文字/链接关键字检测 |
| 2026-01-28 | 首次运行可用 /start 初始化全局管理员（admins.txt） |
| 2026-01-27 | 关键词管理（keywords.txt）+ 群消息命中删除提示 |

## 开发命令

```bash
# 安装依赖
pnpm install

# 编译 TypeScript
npx tsc

# 运行 Bot
node bot.js
```

## Docker 部署

构建镜像：

```bash
docker build -t antiscambot .
```

首次启动前创建持久化数据目录；如果需要沿用当前的关键词和管理员配置，可以将现有文件复制进去：

```bash
mkdir -p data
cp keywords.txt admins.txt data/
```

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

镜像不会包含 `.env`、`keywords.txt` 或 `admins.txt`。`BOT_TOKEN` 通过 `--env-file` 注入，关键词和管理员配置保存在宿主机的 `data/` 目录中。若不需要迁移现有配置，可以跳过复制命令，机器人会自动创建空文件。

## 部署注意事项

1. **必需权限**: 机器人在群里需要 "删除消息" 的管理员权限
2. **隐私模式**: 需要在 @BotFather 中关闭 Privacy Mode，否则无法接收群消息
3. **文件持久化**: keywords.txt 和 admins.txt 需要写入权限
4. **环境变量**: 生产环境建议使用更安全的方式管理 BOT_TOKEN
