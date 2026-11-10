import type { Bot } from "grammy";
import type { BotServices } from "../app/services.js";
import type { BotConfig } from "../app/config.js";
import type { Permissions } from "../app/permissions.js";
import type { Context } from "grammy";
import { MAX_DIGEST_SAMPLE_SIZE } from "../digest/types.js";
import type { SourceChannelInput, TargetChannelInput } from "../digest/types.js";
import { getLocalDate } from "../shared/time.js";
import { createChannelResolver } from "../app/channels.js";
import { formatDigestRunResult } from "../app/result-messages.js";
import { formatLinkSubmissionMessage } from "../link-submission.js";

export function registerChannelCommands(bot: Bot, services: Pick<BotServices, "digestRepository" | "digestService">, permissions: Permissions, config: Pick<BotConfig, "digestTimeZone">): void {
  const resolveManagedChannel = createChannelResolver(bot);

  bot.command("addsource", async (ctx) => {
    if (await permissions.rejectUnauthorizedChannelCommand(ctx)) return;

    const links = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
    if (!links.length) {
      return ctx.reply(
        "用法：/addsource <来源频道最新帖子链接>\n可用空格或换行一次提交多个链接。",
      );
    }

    const repository = services.digestRepository;
    const target = repository.getTarget();
    const resultLines: string[] = [];

    for (const link of links) {
      try {
        const channel = await resolveManagedChannel(link, false);
        if (target?.chatId === channel.chatId) {
          throw new Error("该频道当前是摘要目标频道，不能同时作为来源");
        }

        const source: SourceChannelInput = {
          chatId: channel.chatId,
          title: channel.title,
          username: channel.username,
          linkKind: channel.linkKind,
          linkChannel: channel.linkChannel,
          latestMessageId: channel.messageId,
        };
        const saved = repository.upsertSource(source);
        resultLines.push(
          `✅ ${saved.title}：最新消息 ID ${saved.latestMessageId}`,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        resultLines.push(`❌ ${link}：${reason}`);
      }
    }

    return ctx.reply(resultLines.join("\n"), {
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("sources", async (ctx) => {
    if (await permissions.rejectUnauthorizedChannelCommand(ctx)) return;

    const repository = services.digestRepository;
    const target = repository.getTarget();
    const sources = repository.listActiveSourceStats();
    const lines = [
      "频道摘要配置",
      target
        ? `目标：${target.title} (${target.chatId})`
        : "目标：尚未设置",
      `每个来源频道每日抽样：${repository.getSampleSize()} 条`,
      "",
      `来源频道：${sources.length} 个`,
    ];

    if (!sources.length) {
      lines.push("- 尚未添加来源频道");
    } else {
      for (const [index, source] of sources.entries()) {
        lines.push(
          `${index + 1}. ${source.title}`,
          `   最新 ID: ${source.latestMessageId}｜已用: ${source.usedCount}｜剩余: ${source.remainingCount}`,
        );
      }
    }

    return ctx.reply(lines.join("\n"));
  });

  bot.command("delsource", async (ctx) => {
    if (await permissions.rejectUnauthorizedChannelCommand(ctx)) return;

    const index = Number(ctx.match?.trim() ?? "");
    if (!Number.isSafeInteger(index) || index <= 0) {
      return ctx.reply("用法：/delsource <来源编号>\n来源编号可通过 /sources 查看。");
    }

    const source = services.digestRepository.deactivateSourceByIndex(index);
    if (!source) return ctx.reply("来源编号不存在，请先使用 /sources 查看。");
    return ctx.reply(
      `已停用来源频道：${source.title}\n历史抽取记录仍保留，重新添加后不会重复。`,
    );
  });

  bot.command("settarget", async (ctx) => {
    if (await permissions.rejectUnauthorizedChannelCommand(ctx)) return;

    const links = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
    if (links.length !== 1) {
      return ctx.reply("用法：/settarget <目标频道任意帖子链接>");
    }

    try {
      const link = links[0];
      if (!link) return ctx.reply("用法：/settarget <目标频道任意帖子链接>");
      const channel = await resolveManagedChannel(link, true);
      const repository = services.digestRepository;
      const existingSource = repository.getSource(channel.chatId);
      if (existingSource?.active) {
        throw new Error("该频道当前是摘要来源频道，不能同时作为目标");
      }

      const target: TargetChannelInput = {
        chatId: channel.chatId,
        title: channel.title,
        username: channel.username,
        linkKind: channel.linkKind,
        linkChannel: channel.linkChannel,
      };
      const saved = repository.setTarget(target);
      return ctx.reply(`已设置摘要目标频道：${saved.title} (${saved.chatId})`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return ctx.reply(`设置目标频道失败：${reason}`);
    }
  });

  bot.command("setlinktarget", async (ctx) => {
    if (await permissions.rejectUnauthorizedChannelCommand(ctx)) return;

    const links = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
    if (links.length !== 1) {
      return ctx.reply("用法：/setlinktarget <目标频道任意帖子链接>");
    }

    try {
      const link = links[0];
      if (!link) return ctx.reply("用法：/setlinktarget <目标频道任意帖子链接>");
      const channel = await resolveManagedChannel(link, true, true);
      const saved = services.digestRepository.setLinkSubmissionTarget({
        chatId: channel.chatId,
        title: channel.title,
      });
      return ctx.reply(`已设置链接投稿频道：${saved.title} (${saved.chatId})`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return ctx.reply(`设置链接投稿频道失败：${reason}`);
    }
  });

  bot.command("setsamplesize", async (ctx) => {
    if (await permissions.rejectUnauthorizedChannelCommand(ctx)) return;

    const sampleSize = Number(ctx.match?.trim() ?? "");
    if (
      !Number.isSafeInteger(sampleSize) ||
      sampleSize <= 0 ||
      sampleSize > MAX_DIGEST_SAMPLE_SIZE
    ) {
      return ctx.reply(
        `用法：/setsamplesize <数量>\n数量必须是 1 到 ${MAX_DIGEST_SAMPLE_SIZE} 的整数。`,
      );
    }

    const saved = services.digestRepository.setSampleSize(sampleSize);
    services.digestService.setSampleSize(saved);
    return ctx.reply(`已设置每个来源频道每日抽样数量：${saved} 条。`);
  });

  bot.command("digestnow", async (ctx) => {
    if (await permissions.rejectUnauthorizedChannelCommand(ctx)) return;

    const result = await services.digestService.run(
      "manual",
      getLocalDate(new Date(), config.digestTimeZone),
    );
    return ctx.reply(formatDigestRunResult(result));
  });

}

export async function handleLinkSubmission(ctx: Context, services: Pick<BotServices, "digestRepository">, permissions: Permissions): Promise<void> {
  const message = ctx.message;
  if (!permissions.canManageChannels(ctx) || !message?.text) return;

  const isCommand = message.entities?.some(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (isCommand || !/\|\s*原文\s*\(/u.test(message.text)) return;

  const repository = services.digestRepository;
  const target = repository.getLinkSubmissionTarget();
  if (!target) {
    await ctx.reply(
      "尚未设置链接投稿频道。请先使用 /setlinktarget <目标频道任意帖子链接>。",
    );
    return;
  }

  try {
    const formatted = formatLinkSubmissionMessage(message.text);
    if (!formatted) return;
    let sentMessages = 0;
    for (const chunk of formatted.chunks) {
      await ctx.api.sendMessage(target.chatId, chunk, {
        parse_mode: "HTML",
      });
      sentMessages += 1;
    }
    await ctx.reply(
      `已发布 ${formatted.count} 条链接到 ${target.title}（${sentMessages} 条频道消息）。`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await ctx.reply(`链接发布失败：${reason}`);
  }
}
