import type { Context } from "grammy";
import type { AdminStore } from "../storage/admins.js";

export type Permissions = ReturnType<typeof createPermissions>;

export function createPermissions(admins: Pick<AdminStore, "isGlobal">) {
  async function canManageKeywords(ctx: Context): Promise<boolean> {
    if (!ctx.from) return false;
    if (admins.isGlobal(ctx.from.id)) return true;

    if (!ctx.chat) return false;
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return false;

    try {
      const chatAdmins = await ctx.api.getChatAdministrators(ctx.chat.id);
      return chatAdmins.some((m) => m.user.id === ctx.from!.id);
    } catch {
      return false;
    }
  }

  function canManageChannels(ctx: Context): boolean {
    return (
      ctx.chat?.type === "private" &&
      !!ctx.from &&
      admins.isGlobal(ctx.from.id)
    );
  }

  async function rejectUnauthorizedChannelCommand(ctx: Context): Promise<boolean> {
    if (canManageChannels(ctx)) return false;
    await ctx.reply("无权限：频道配置只能由全局管理员在 Bot 私聊中操作。");
    return true;
  }

  return { canManageKeywords, canManageChannels, rejectUnauthorizedChannelCommand };
}
