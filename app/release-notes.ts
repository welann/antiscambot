type ReleaseNote = { version: string; summary: string };

const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "2026-11-11",
    summary: "新增独立格式审核：整条消息恰好为 @Bot用户名 加两段内容时自动删除；每日摘要改为按消息 ID 等分区间抽取，每个区间取最远离历史抽样的空位",
  },
  {
    version: "2026-10-08",
    summary: "删除详情独立发送，原回复位置仅显示简短提示；所有可编辑频道转换链接并保留附言；新增 /clearkw 清空关键词",
  },
  {
    version: "2026-09-13",
    summary: "新增布告栏日历：设置频道立即发图，每天北京时间 08:00 自动发送 #布告栏",
  },
  {
    version: "2026-08-18",
    summary: "投稿频道内的固定格式链接可直接编辑原消息，保留回复关系",
  },
  {
    version: "2026-08-13",
    summary: "新增固定格式链接投稿，可发布带预览的频道超链接",
  },
  {
    version: "2026-08-02",
    summary: "频道摘要发送自动重试，并支持命令调整每日抽样数量",
  },
  {
    version: "2026-07-23",
    summary: "新增多频道历史随机链接汇总与 SQLite 持久化",
  },
  {
    version: "2026-02-28",
    summary: "新增发送者用户名关键字检测",
  },
  {
    version: "2026-02-05",
    summary: "新增 edited_message 检测：编辑后命中关键字也会删除",
  },
  {
    version: "2026-02-01",
    summary: "新增 inline keyboard 按钮文字/链接关键字检测",
  },
  {
    version: "2026-01-28",
    summary: "首次运行可用 /start 初始化全局管理员（admins.txt）",
  },
  {
    version: "2026-01-27",
    summary: "关键词管理（keywords.txt）+ 群消息命中删除提示",
  },
];

export const LOGIC_VERSION = RELEASE_NOTES[0]?.version ?? "unknown";

export function formatReleaseNotesForStart(maxItems = 10): string[] {
  if (!RELEASE_NOTES.length) return [];

  return [
    "RELEASE_NOTES:",
    ...RELEASE_NOTES.slice(0, maxItems).map((note) => `- ${note.version}: ${note.summary}`),
  ];
}
