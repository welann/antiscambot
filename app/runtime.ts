import { Api, GrammyError, InputFile } from "grammy";
import { schedule } from "node-cron";
import type { ScheduledTask } from "node-cron";
import { KeywordStore } from "../storage/keywords.js";
import { AdminStore } from "../storage/admins.js";
import { DigestRepository, DigestService } from "../digest.js";
import {
  CalendarRepository, CalendarService, CalendarSendRejectedError,
  CALENDAR_CRON, CALENDAR_TIMEZONE, calendarIsDue, formatCalendarResult, renderCalendarImage,
} from "../calendar.js";
import { getLocalDate, shouldRunDailyCatchUp } from "../shared/time.js";
import type { BotConfig } from "./config.js";
import { createBot } from "./create-bot.js";
import { formatDigestRunResult } from "./result-messages.js";

export async function runBot(config: BotConfig): Promise<void> {
  const keywords = new KeywordStore(config.keywordsFile);
  const admins = new AdminStore(config.adminsFile, config.adminIds);
  await keywords.load();
  await admins.load();

  const repository = new DigestRepository(config.databaseFile, {
    cronExpression: config.digestCron, timeZone: config.digestTimeZone, sampleSize: config.digestSampleSize,
  });
  let calendarRepository: CalendarRepository | undefined;
  let calendarService: CalendarService | undefined;
  const tasks: ScheduledTask[] = [];
  const pendingJobs = new Set<Promise<void>>();
  let removeSignalHandlers = () => {};

  const trackedJob = (name: string, run: () => Promise<void>) => () => {
    const promise = Promise.resolve().then(run).catch((error) => {
      console.error(`[${name}] 定时任务异常：`, error);
    });
    pendingJobs.add(promise);
    void promise.finally(() => pendingJobs.delete(promise));
    return promise;
  };

  try {
    const api = new Api(config.botToken);
    const digestService = new DigestService(repository, async (chatId, html) => {
      const sent = await api.sendMessage(chatId, html, {
        parse_mode: "HTML", link_preview_options: { is_disabled: true },
      });
      return { messageId: sent.message_id };
    }, repository.getSampleSize(), { sendMaxAttempts: config.digestSendMaxAttempts });

    calendarRepository = new CalendarRepository(config.databaseFile);
    calendarService = new CalendarService(calendarRepository, renderCalendarImage, async (target, image, caption) => {
      try {
        const message = await api.sendPhoto(target, new InputFile(image, "daily-calendar.png"), { caption });
        return message.message_id;
      } catch (error) {
        if (error instanceof GrammyError) throw new CalendarSendRejectedError(error.description);
        throw error;
      }
    });
    const calendar = calendarService;
    const bot = createBot(config, { keywords, admins, digestRepository: repository, digestService, calendarService });
    bot.catch((error) => console.error("Bot handler failed:", error.error));
    let stopRequested = false;
    const requestStop = () => {
      stopRequested = true;
      if (bot.isRunning()) void bot.stop().catch((error) => console.error("Bot stop failed:", error));
    };
    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);
    removeSignalHandlers = () => {
      process.off("SIGINT", requestStop);
      process.off("SIGTERM", requestStop);
    };

    await bot.init();
    if (stopRequested) return;
    const runDigest = trackedJob("digest", async () => {
      const result = await digestService.run("scheduled", getLocalDate(new Date(), config.digestTimeZone));
      const log = result.status === "failed" || result.status === "not-configured" ? console.error : console.log;
      log(`[digest] ${formatDigestRunResult(result)}`);
    });
    const runCalendar = trackedJob("calendar", async () => {
      const result = await calendar.run();
      if (result.status !== "not-configured" && result.status !== "already-sent") {
        console.log(`[calendar] ${formatCalendarResult(result)}`);
      }
    });
    tasks.push(schedule(config.digestCron, runDigest, {
      timezone: config.digestTimeZone, noOverlap: true, name: "daily-channel-digest",
    }));
    tasks.push(schedule(CALENDAR_CRON, runCalendar, {
      timezone: CALENDAR_TIMEZONE, noOverlap: true, name: "daily-calendar-bulletin",
    }));

    const now = new Date();
    if (calendarIsDue(now)) await runCalendar();
    if (!stopRequested && shouldRunDailyCatchUp(config.digestCron, config.digestTimeZone, now) &&
      !repository.hasScheduledRun(getLocalDate(now, config.digestTimeZone))) {
      await runDigest();
    }
    if (!stopRequested) {
      await bot.start({ allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"] });
    }
  } finally {
    removeSignalHandlers();
    // Stop new work and let active scheduled sends finish before closing SQLite.
    await Promise.allSettled(tasks.map((task) => task.destroy()));
    await Promise.allSettled(pendingJobs);
    await calendarService?.idle();
    calendarRepository?.close();
    repository.close();
  }
}
