import { randomInt } from "node:crypto";

import { buildTelegramMessageLink, formatDigestChunks } from "./formatting.js";
import type { DigestRepository } from "./repository.js";
import { MAX_DIGEST_SAMPLE_SIZE } from "./types.js";

import type {
  DigestRunResult,
  DigestSection,
  DigestSender,
  DigestSendResult,
  DigestServiceOptions,
  DigestTrigger,
} from "./types.js";

const DEFAULT_SEND_MAX_ATTEMPTS = 3;

const DEFAULT_SEND_RETRY_DELAY_MS = 1_000;

const MAX_SEND_RETRY_DELAY_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function upperBound(sortedValues: number[], target: number): number {
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = sortedValues[middle];
    if (value !== undefined && value <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function availableIdAtRank(
  rank: number,
  maxMessageId: number,
  usedSorted: number[],
): number {
  let low = 1;
  let high = maxMessageId;
  const desiredCount = rank + 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const usedThroughMiddle = upperBound(usedSorted, middle);
    const availableThroughMiddle = middle - usedThroughMiddle;
    if (availableThroughMiddle >= desiredCount) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

export function selectUnusedMessageIds(
  maxMessageId: number,
  usedMessageIds: ReadonlySet<number>,
  requestedCount: number,
  chooseRandomInt: (maxExclusive: number) => number = randomInt,
): number[] {
  if (!Number.isSafeInteger(maxMessageId) || maxMessageId <= 0) return [];
  if (!Number.isSafeInteger(requestedCount) || requestedCount <= 0) return [];

  const usedSorted = Array.from(usedMessageIds)
    .filter((id) => Number.isSafeInteger(id) && id >= 1 && id <= maxMessageId)
    .sort((a, b) => a - b);
  const remainingCount = maxMessageId - usedSorted.length;
  const desiredCount = Math.min(requestedCount, remainingCount);
  if (desiredCount <= 0) return [];

  const selectedRanks = new Set<number>();
  while (selectedRanks.size < desiredCount) {
    const value = chooseRandomInt(remainingCount);
    if (!Number.isSafeInteger(value) || value < 0 || value >= remainingCount) {
      throw new Error("随机数生成器返回了范围外的值");
    }
    selectedRanks.add(value);
  }

  return Array.from(selectedRanks, (rank) =>
    availableIdAtRank(rank, maxMessageId, usedSorted),
  );
}

export class DigestService {
  private running = false;
  private readonly sendMaxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly repository: DigestRepository,
    private readonly sender: DigestSender,
    private sampleSize: number,
    options: DigestServiceOptions = {},
  ) {
    this.sendMaxAttempts = options.sendMaxAttempts ?? DEFAULT_SEND_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_SEND_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(this.sendMaxAttempts) || this.sendMaxAttempts <= 0) {
      throw new Error("sendMaxAttempts must be a positive integer");
    }
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error("retryDelayMs must be a non-negative integer");
    }
    this.setSampleSize(sampleSize);
  }

  private async sendWithRetry(
    targetChatId: number,
    html: string,
  ): Promise<DigestSendResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.sendMaxAttempts; attempt += 1) {
      try {
        return await this.sender(targetChatId, html);
      } catch (error) {
        lastError = error;
        if (attempt === this.sendMaxAttempts) break;

        const delayMs = Math.min(
          this.retryDelayMs * 2 ** (attempt - 1),
          MAX_SEND_RETRY_DELAY_MS,
        );
        if (delayMs > 0) await waitForRetry(delayMs);
      }
    }

    throw new Error(
      `发送失败，已尝试 ${this.sendMaxAttempts} 次：${errorMessage(lastError)}`,
      { cause: lastError },
    );
  }

  setSampleSize(sampleSize: number): void {
    if (
      !Number.isSafeInteger(sampleSize) ||
      sampleSize <= 0 ||
      sampleSize > MAX_DIGEST_SAMPLE_SIZE
    ) {
      throw new Error(`sampleSize must be an integer between 1 and ${MAX_DIGEST_SAMPLE_SIZE}`);
    }
    this.sampleSize = sampleSize;
  }

  private getItemCountForRuns(runIds: Set<string>): number {
    let itemCount = 0;
    for (const runId of runIds) {
      itemCount += this.repository.getRunItemCount(runId);
    }
    return itemCount;
  }

  private async retryFailedChunks(
    targetChatId: number,
  ): Promise<DigestRunResult | null> {
    const chunks = this.repository.listFailedChunks();
    if (!chunks.length) return null;

    const runIds = new Set(chunks.map((chunk) => chunk.runId));
    let sentMessages = 0;
    for (const chunk of chunks) {
      this.repository.markChunkDispatching(chunk.runId, chunk.chunkIndex);
      try {
        const result = await this.sendWithRetry(targetChatId, chunk.html);
        this.repository.markChunkSent(chunk.runId, chunk.chunkIndex, result.messageId);
        this.repository.completeRunIfAllChunksSent(chunk.runId);
        sentMessages += 1;
      } catch (error) {
        const reason = errorMessage(error);
        this.repository.markChunkFailed(chunk.runId, chunk.chunkIndex, reason);
        return {
          status: "failed",
          itemCount: this.getItemCountForRuns(runIds),
          messageCount: sentMessages,
          error: reason,
        };
      }
    }

    return {
      status: "sent",
      itemCount: this.getItemCountForRuns(runIds),
      messageCount: sentMessages,
      error: null,
    };
  }

  async run(
    trigger: DigestTrigger,
    localDate: string,
  ): Promise<DigestRunResult> {
    if (this.running) {
      return {
        status: "busy",
        itemCount: 0,
        messageCount: 0,
        error: "已有摘要任务正在运行",
      };
    }

    const target = this.repository.getTarget();
    if (!target) {
      return {
        status: "not-configured",
        itemCount: 0,
        messageCount: 0,
        error: "尚未设置目标频道",
      };
    }

    this.running = true;
    let runId: string | null = null;
    try {
      const retriedResult = await this.retryFailedChunks(target.chatId);
      if (retriedResult) return retriedResult;

      const sources = this.repository.listActiveSources();
      if (!sources.length) {
        return {
          status: "not-configured",
          itemCount: 0,
          messageCount: 0,
          error: "尚未添加来源频道",
        };
      }

      runId = this.repository.beginRun(trigger, localDate);
      if (!runId) {
        return {
          status: "already-ran",
          itemCount: 0,
          messageCount: 0,
          error: null,
        };
      }

      const sections: DigestSection[] = [];
      for (const source of sources) {
        const usedIds = this.repository.getUsedMessageIds(source.chatId);
        const selectedIds = selectUnusedMessageIds(
          source.latestMessageId,
          usedIds,
          this.sampleSize,
        );
        if (!selectedIds.length) continue;

        sections.push({
          source,
          selections: selectedIds.map((messageId) => ({
            sourceChatId: source.chatId,
            sourceMessageId: messageId,
            sourceTitle: source.title,
            messageLink: buildTelegramMessageLink(source, messageId),
          })),
        });
      }

      const chunks = formatDigestChunks(sections, localDate);
      if (!chunks.length) {
        this.repository.completeRun(runId);
        return {
          status: "empty",
          itemCount: 0,
          messageCount: 0,
          error: null,
        };
      }

      let sentMessages = 0;
      for (const [chunkIndex, chunk] of chunks.entries()) {
        this.repository.reserveChunk(runId, chunkIndex, chunk);
        this.repository.markChunkDispatching(runId, chunkIndex);
        try {
          const result = await this.sendWithRetry(target.chatId, chunk.html);
          this.repository.markChunkSent(runId, chunkIndex, result.messageId);
          sentMessages += 1;
        } catch (error) {
          const reason = errorMessage(error);
          this.repository.markChunkFailed(runId, chunkIndex, reason);
          return {
            status: "failed",
            itemCount: this.repository.getRunItemCount(runId),
            messageCount: sentMessages,
            error: reason,
          };
        }
      }

      this.repository.completeRun(runId);
      return {
        status: "sent",
        itemCount: this.repository.getRunItemCount(runId),
        messageCount: sentMessages,
        error: null,
      };
    } catch (error) {
      const reason = errorMessage(error);
      if (runId) this.repository.failRun(runId, reason);
      return {
        status: "failed",
        itemCount: runId ? this.repository.getRunItemCount(runId) : 0,
        messageCount: 0,
        error: reason,
      };
    } finally {
      this.running = false;
    }
  }
}
