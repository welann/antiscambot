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

type FreeGap = {
  left: number | null;
  right: number | null;
  start: number;
  end: number;
};

function buildFreeGaps(
  maxMessageId: number,
  usedSorted: number[],
): FreeGap[] {
  if (!usedSorted.length) {
    return [{ left: null, right: null, start: 1, end: maxMessageId }];
  }

  const gaps: FreeGap[] = [];
  const first = usedSorted[0]!;
  if (first > 1) {
    gaps.push({ left: null, right: first, start: 1, end: first - 1 });
  }

  for (let index = 0; index + 1 < usedSorted.length; index += 1) {
    const left = usedSorted[index]!;
    const right = usedSorted[index + 1]!;
    if (right - left > 1) {
      gaps.push({ left, right, start: left + 1, end: right - 1 });
    }
  }

  const last = usedSorted[usedSorted.length - 1]!;
  if (last < maxMessageId) {
    gaps.push({ left: last, right: null, start: last + 1, end: maxMessageId });
  }
  return gaps;
}

function gapCapacity(gap: FreeGap, spacing: number): number {
  const freeCount = gap.end - gap.start + 1;
  if (gap.left === null && gap.right === null) {
    return Math.floor((freeCount - 1) / spacing) + 1;
  }
  if (gap.left === null || gap.right === null) {
    return Math.floor(freeCount / spacing);
  }
  return Math.max(0, Math.floor((freeCount + 1) / spacing) - 1);
}

function totalCapacity(
  gaps: FreeGap[],
  spacing: number,
  pointCount: number,
): number {
  let total = 0;
  for (const gap of gaps) {
    total += gapCapacity(gap, spacing);
    if (total >= pointCount) return total;
  }
  return total;
}

function maximumSpacing(
  gaps: FreeGap[],
  pointCount: number,
  maxMessageId: number,
): number {
  let low = 1;
  let high = maxMessageId;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (totalCapacity(gaps, middle, pointCount) >= pointCount) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

// Break equal-width ties with a bit-reversal order so one batch spreads across
// the channel instead of filling the first gaps.
function spreadRank(index: number, count: number): number {
  let bits = 0;
  while (1 << bits < count) bits += 1;
  let value = index;
  let rank = 0;
  for (let bit = 0; bit < bits; bit += 1) {
    rank = (rank << 1) | (value & 1);
    value >>= 1;
  }
  return rank;
}

function allocateGapPoints(
  gaps: FreeGap[],
  capacities: number[],
  pointCount: number,
): number[] {
  const counts = new Array<number>(gaps.length).fill(0);
  const ranks = gaps.map((_, index) => spreadRank(index, gaps.length));
  const order = gaps
    .map((_, index) => index)
    .sort((a, b) => {
      const freeA = gaps[a]!.end - gaps[a]!.start;
      const freeB = gaps[b]!.end - gaps[b]!.start;
      return freeB - freeA || ranks[a]! - ranks[b]!;
    });

  let remaining = pointCount;
  while (remaining > 0) {
    let added = false;
    for (const index of order) {
      if (remaining === 0) break;
      if (counts[index]! < capacities[index]!) {
        counts[index] = counts[index]! + 1;
        remaining -= 1;
        added = true;
      }
    }
    if (!added) throw new Error("无法分配摘要抽样序号");
  }
  return counts;
}

function placeGapPoints(
  gap: FreeGap,
  count: number,
  spacing: number,
  maxMessageId: number,
): number[] {
  if (count === 0) return [];

  const low = gap.left === null ? 1 : gap.left + spacing;
  const high = gap.right === null ? maxMessageId : gap.right - spacing;
  if (count === 1) {
    return [low + Math.floor((high - low) / 2)];
  }

  const span = high - low;
  return Array.from(
    { length: count },
    (_, index) => low + Math.floor((index * span) / (count - 1)),
  );
}

// Choose points that maximize the minimum distance to used IDs and to each
// other. Each gap can hold a bounded number of points at a given spacing;
// binary search finds the largest spacing with enough total capacity.
export function selectUnusedMessageIds(
  maxMessageId: number,
  usedMessageIds: ReadonlySet<number>,
  requestedCount: number,
): number[] {
  if (!Number.isSafeInteger(maxMessageId) || maxMessageId <= 0) return [];
  if (!Number.isSafeInteger(requestedCount) || requestedCount <= 0) return [];

  const usedSorted = Array.from(usedMessageIds)
    .filter((id) => Number.isSafeInteger(id) && id >= 1 && id <= maxMessageId)
    .sort((a, b) => a - b);
  const pointCount = Math.min(
    requestedCount,
    maxMessageId - usedSorted.length,
  );
  if (pointCount <= 0) return [];

  const gaps = buildFreeGaps(maxMessageId, usedSorted);
  const spacing = maximumSpacing(gaps, pointCount, maxMessageId);
  const capacities = gaps.map((gap) => gapCapacity(gap, spacing));
  const counts = allocateGapPoints(gaps, capacities, pointCount);

  const selected: number[] = [];
  for (const [index, gap] of gaps.entries()) {
    selected.push(
      ...placeGapPoints(gap, counts[index]!, spacing, maxMessageId),
    );
  }
  return selected;
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
