# 架构说明

## 模块边界

`bot.ts` 仅加载 dotenv、调用 `readConfig()` / `runBot()` 并报告启动失败。业务模块不应导入这个会启动进程的入口。

| 层 | 职责与依赖 |
| --- | --- |
| `app/config.ts` | 将环境变量解析为 `BotConfig`，校验 token、cron、时区和数值范围 |
| `app/runtime.ts` | 创建 TXT store、SQLite repository、service 和 Telegram 发送适配器；拥有调度与资源生命周期 |
| `app/create-bot.ts`、`services.ts` | `createBot(config, services)` 仅组装路由；通过 `BotServices` 显式传入依赖，不打开文件/数据库、不联网、不启动 cron |
| `commands/`、`app/messages.ts` | 命令及消息路由；调用权限、频道校验和业务服务，不直接操作 TXT 或编写 SQL |
| `app/permissions.ts`、`channels.ts` | 前者决定用户权限，后者解析频道并查询 Bot 的管理员、发布和编辑权限 |
| `moderation/rules.ts`、`handler.ts` | 规则是纯函数；handler 排除自身消息、非群消息和命令，再匹配并调用 `message-handling.ts` 删除通知流程 |
| `storage/` | `KeywordStore` / `AdminStore` 管理内存快照与 TXT；`text-file.ts` 提供串行队列和同目录临时文件替换 |
| `digest/` | `types.ts` 定义契约，`repository.ts` 管理 SQL/迁移，`service.ts` 调用仓储和注入的发送器并以最大最小 ID 间距选择抽样，`formatting.ts` 处理链接及 HTML |
| `calendar.ts` | 保留日历仓储、发送状态机及渲染适配；只在需要发图时动态加载独立 JS 组件 `calendar-studio/renderer.js` |
| `shared/time.ts` | 无业务状态的时区与每日补执行函数，供摘要和日历共用 |

根 `digest.ts` 继续重导出原公开接口，兼容旧导入路径。提示文字集中在 `app/result-messages.ts`、`app/release-notes.ts` 等对应模块，不应放进仓储。

## 增加审核规则

1. 在 `moderation/rules.ts` 增加无 I/O 的匹配函数，用输入消息返回命中信息或 `null`，先补正反例测试。
2. 在 `moderation/handler.ts` 显式安排匹配顺序并生成原因说明，继续复用 `deleteWithNotice()`。当前顺序是三段规则优先、关键词其次；关键词按候选字段顺序检查，在单个字段内最长优先。
3. 在 `tests/` 补新消息和编辑消息路由测试，并验证私聊、频道、命令及 Bot 自身消息不误删。现有三段规则仅检查正文/caption，不依赖关键词，因此 `/clearkw` 不会禁用它。

## 增加命令

1. 在对应 `commands/keywords.ts`、`channels.ts` 或 `calendar.ts` 中注册命令，先调用 `Permissions` 授权；频道配置及日历命令仅全局管理员私聊可用。
2. 持久化和发送逻辑放进 store/repository/service。新增依赖时扩展 `BotServices`，由 `app/runtime.ts` 创建，不在 handler 中临时打开数据库。
3. 新命令模块由 `createBot()` 注册，更新 `/start` 帮助与 README；用注入的服务及受控 Telegram API 测试路由。`pnpm run typecheck` 检查类型，`pnpm test` 运行应用和日历组件单元测试。

## 数据兼容

- `keywords.txt` 仍是一行一个关键词：忽略空行、去除首尾空白、大小写去重并保留首个写法。列表全局共享；原 `add/remove` 返回结构保持不变。
- `admins.txt` 仍是一行一个正整数 ID；文件管理员与配置管理员取并集，环境变量中的 ID 不写回文件。仅无任何管理员时允许首次 `/start` 初始化。
- 写入先生成新快照，临时文件写入并同步后执行同目录 rename，成功才发布内存状态；失败向调用方抛错，不阻塞后续排队操作。启动先等待两个 store 的 `load()`。
- `DIGEST_DB_FILE` 继续保存摘要、投稿目标和日历数据。摘要 schema 仍为 v2，沿用迁移、完整性检查、预留 ID 与失败发送恢复；日历继续使用 `calendar_config` / `calendar_deliveries`。这次拆分无需重新导入数据或重建表。

## 启动与退出

`runBot()` 加载 TXT、创建仓储及服务、组装 Bot、执行 `bot.init()`，再注册两个 cron、按条件补执行并启动长轮询。`createBot()` 本身没有这些启动副作用，方便隔离测试。

SIGINT/SIGTERM 请求停止轮询；`finally` 移除信号监听、销毁 cron、等待已跟踪任务和 `CalendarService.idle()`，最后关闭日历与摘要连接。退出没有自定义超时或强制取消；异常中断后的恢复依赖持久化记录。日历 `rendering` 恢复为可重试失败，`sending` 恢复为 `uncertain`，避免自动重复发图。

## 保留限制与部署

- 文件队列只对同一 store 实例有效，没有跨实例/跨进程锁或文件变更监听；同一份数据应由单个 Bot 进程管理，不能靠多建 store 实例实现并发安全。
- 摘要和日历使用同一数据库文件，但各自持有独立 `DatabaseSync` 连接，未统一为一个工作单元，也没有跨模块事务。SQLite 操作仍是同步的。
- 摘要只抽取消息 ID，不验证历史内容是否存在；`selectUnusedMessageIds()` 是确定性的 maximin 选择，只优化 ID 间距，不保证内容主题多样。发送前预留能防止重复抽样，但网络结果不明时的发送重试不保证 Telegram 端恰好一次。启动补摘要只识别固定每日 `分 时 * * *`，不补更早日期。
- `pnpm run build` 用 `tsconfig.build.json` 输出生产代码到 `dist/`，`pnpm start` 运行 `dist/bot.js`。Docker 复制整个运行模块树，并在同级保留 `calendar-studio` 的 JS 与资源；渲染组件未重写，浏览器集成脚本也不属于默认 `pnpm test`。
- TXT 格式仍按行解析，未引入多行关键词转义；存储没有新增远程备份。权限、持久化目录、Chromium 和环境变量配置见 [README](../Readme.md)。
