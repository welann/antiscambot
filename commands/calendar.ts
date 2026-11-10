import type { Bot } from "grammy";
import type { BotServices } from "../app/services.js";
import type { Permissions } from "../app/permissions.js";
import { calendarDate, formatCalendarResult } from "../calendar.js";
import { createChannelResolver } from "../app/channels.js";

export function registerCalendarCommands(bot: Bot, services: Pick<BotServices, "calendarService">, permissions: Permissions): void {
  const resolveManagedChannel = createChannelResolver(bot);

  bot.command("setcalendartarget", async (ctx) => {
    if (await permissions.rejectUnauthorizedChannelCommand(ctx)) return;
    const links = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (links.length !== 1) return ctx.reply("用法：/setcalendartarget <目标频道任意帖子链接>");
    try {
      const channel = await resolveManagedChannel(links[0]!, true);
      const task = services.calendarService.configureAndSend({ chatId: channel.chatId, title: channel.title });
      const result = await task;
      return ctx.reply(`已设置布告栏频道：${channel.title} (${channel.chatId})\n${formatCalendarResult(result)}\n此后每天北京时间 08:00 发送新日历。`);
    } catch (error) {
      return ctx.reply(`设置布告栏频道失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.command("calendarstatus", async (ctx) => {
    if (await permissions.rejectUnauthorizedChannelCommand(ctx)) return;
    const repository = services.calendarService.repository;
    const target = repository.getTarget();
    if (!target) return ctx.reply("未设置布告栏频道。使用 /setcalendartarget <频道帖子链接> 开启。");
    const delivery = repository.getDelivery(target.chatId, calendarDate());
    const states: Record<string, string> = { rendering: "生成中", sending: "发送中", sent: "已发送", failed: "失败，可手动补发", uncertain: "结果不明，请检查频道后再手动补发" };
    return ctx.reply(`布告栏频道：${target.title} (${target.chatId})\n时间：每天北京时间 08:00\n图片说明：#布告栏\n今日状态：${delivery ? states[delivery.status] : "尚未发送"}${delivery?.error ? `\n原因：${delivery.error}` : ""}`);
  });

  bot.command("calendarnow", async (ctx) => {
    if (await permissions.rejectUnauthorizedChannelCommand(ctx)) return;
    const result = await services.calendarService.run(new Date(), { retryUncertain: true, force: true });
    return ctx.reply(formatCalendarResult(result, true));
  });

  bot.command("stopcalendar", async (ctx) => {
    if (await permissions.rejectUnauthorizedChannelCommand(ctx)) return;
    try {
      services.calendarService.stop();
      return ctx.reply("已停用自动日历发送。历史记录保留，可用 /setcalendartarget 重新开启。");
    } catch (error) {
      return ctx.reply(error instanceof Error ? error.message : String(error));
    }
  });

}
