import type { Bot } from "grammy";
import type { BotServices } from "../app/services.js";
import type { Permissions } from "../app/permissions.js";
import { LOGIC_VERSION, formatReleaseNotesForStart } from "../app/release-notes.js";

export function registerKeywordCommands(bot: Bot, services: Pick<BotServices, "keywords" | "admins">, permissions: Permissions): void {
  bot.command("start", async (ctx) => {
    const becameAdmin = ctx.from
      ? await services.admins.bootstrapFirst(ctx.from.id)
      : false;

    const lines: string[] = [];

    if (becameAdmin) {
      lines.push(
        "已初始化管理员：你是第一个使用 /start 的用户，已记录为全局管理员。",
        "",
      );
    }

    lines.push("Anti-scam bot is running.", `版本：${LOGIC_VERSION}`);

    const releaseNotes = formatReleaseNotesForStart();
    if (releaseNotes.length) {
      lines.push("", ...releaseNotes);
    }

    lines.push(
      "",
      "Commands:",
      "- /addkw <keyword>  添加待检测关键字 (管理员)",
      "- /delkw <keyword>  删除关键字 (管理员)",
      "- /clearkw          删除全部关键字 (管理员，全局生效)",
      "- /keywords         查看所有关键字",
      "- /addsource <links> 添加摘要来源频道 (全局管理员私聊)",
      "- /sources           查看摘要来源与目标",
      "- /delsource <编号>  停用摘要来源",
      "- /settarget <link>  设置摘要目标频道",
      "- /setsamplesize <数量> 设置每个来源频道每日抽样数量",
      "- /setlinktarget <link> 设置链接投稿频道",
      "- /setcalendartarget <link> 设置布告栏频道并立即发图",
      "- /calendarstatus    查看日历发送设置与状态",
      "- /calendarnow       强制重新发送今日日历",
      "- /stopcalendar      停止自动发送日历",
      "- /digestnow         立即发送一次摘要",
    );

    return ctx.reply(lines.join("\n"));
  });

  bot.command("addkw", async (ctx) => {
    if (!(await permissions.canManageKeywords(ctx))) {
      return ctx.reply(
        "无权限：仅群管理员可操作（或设置 KEYWORD_ADMIN_IDS=123,456；首次运行可用 /start 初始化全局管理员）。",
      );
    }

    const keyword = ctx.match?.trim() ?? "";
    const result = await services.keywords.add(keyword);

    if (!result.added) {
      if (result.reason === "empty") return ctx.reply("用法：/addkw <keyword>");
      if (result.reason === "exists") {
        return ctx.reply(`关键字已存在：${result.keyword}`);
      }
      return ctx.reply("添加失败。");
    }

    return ctx.reply(`已添加关键字：${result.keyword}`);
  });

  bot.command("delkw", async (ctx) => {
    if (!(await permissions.canManageKeywords(ctx))) {
      return ctx.reply(
        "无权限：仅群管理员可操作（或设置 KEYWORD_ADMIN_IDS=123,456；首次运行可用 /start 初始化全局管理员）。",
      );
    }

    const keyword = ctx.match?.trim() ?? "";
    const result = await services.keywords.remove(keyword);

    if (!result.removed) {
      if (result.reason === "empty") return ctx.reply("用法：/delkw <keyword>");
      if (result.reason === "missing") return ctx.reply("关键字不存在。");
      return ctx.reply("删除失败。");
    }

    return ctx.reply(`已删除关键字：${result.keyword}`);
  });

  bot.command("clearkw", async (ctx) => {
    if (!(await permissions.canManageKeywords(ctx))) {
      return ctx.reply("无权限：仅群管理员或全局管理员可清空关键词。");
    }
    try {
      const count = await services.keywords.clear();
      return ctx.reply(`已删除全部 ${count} 个关键词，对所有群聊生效。`);
    } catch (error) {
      return ctx.reply(`清空关键词失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.command("keywords", (ctx) => {
    const keywords = services.keywords.list();
    if (!keywords.length) return ctx.reply("当前没有任何待检测关键字。");

    return ctx.reply(["当前待检测关键字：", ...keywords.map((k) => `- ${k}`)].join("\n"));
  });

}
