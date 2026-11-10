import type { DigestService } from "../digest.js";

export function formatDigestRunResult(
  result: Awaited<ReturnType<DigestService["run"]>>,
): string {
  switch (result.status) {
    case "sent":
      return `汇总发送完成：${result.itemCount} 个链接，${result.messageCount} 条目标消息。`;
    case "empty":
      return "没有可用的新序号：所有来源均已耗尽。";
    case "busy":
      return "已有摘要任务正在运行，请稍后重试。";
    case "already-ran":
      return "今天的自动汇总已经执行过。";
    case "not-configured":
      return `摘要配置不完整：${result.error ?? "未知原因"}`;
    case "failed":
      return `摘要发送失败：${result.error ?? "未知错误"}。已预留的序号不会再次抽取。`;
  }
}
