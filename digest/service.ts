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

type FreeRange = {
  start: number;
  end: number;
};

function buildFreeRanges(
  maxMessageId: number,
  usedSorted: number[],
): FreeRange[] {
  const ranges: FreeRange[] = [];
  let next = 1;
  for (const used of usedSorted) {
    if (used > next) ranges.push({ start: next, end: used - 1 });
    next = used + 1;
  }
  if (next <= maxMessageId) {
    ranges.push({ start: next, end: maxMessageId });
  }
  return ranges;
}

type Band = {
  low: number;
  high: number;
  pieces: FreeRange[];
};

// Split the channel into equal ID bands. Every band contributes at most one
// sample, so a single digest always spans the whole channel evenly.
function buildBands(
  maxMessageId: number,
  bandCount: number,
  ranges: FreeRange[],
): Band[] {
  const bands: Band[] = [];
  let rangeIndex = 0;
  for (let index = 0; index < bandCount; index += 1) {
    const low = Math.floor((index * maxMessageId) / bandCount) + 1;
    const high = Math.floor(((index + 1) * maxMessageId) / bandCount);
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.end < low) {
      rangeIndex += 1;
    }
    const pieces: FreeRange[] = [];
    for (
      let scan = rangeIndex;
      scan < ranges.length && ranges[scan]!.start <= high;
      scan += 1
    ) {
      const start = Math.max(ranges[scan]!.start, low);
      const end = Math.min(ranges[scan]!.end, high);
      if (start <= end) pieces.push({ start, end });
    }
    bands.push({ low, high, pieces });
  }
  return bands;
}

// Take the midpoint of the widest free piece left in the band: it is the ID
// farthest from the used IDs and earlier samples around it. Equal-width
// pieces resolve toward the band center.
function takeBandPoint(band: Band): number | null {
  let bestIndex = -1;
  let bestSpan = -1;
  let bestCenterDistance = Number.POSITIVE_INFINITY;
  const bandCenter = (band.low + band.high) / 2;
  for (let index = 0; index < band.pieces.length; index += 1) {
    const piece = band.pieces[index]!;
    const span = piece.end - piece.start;
    const centerDistance = Math.abs(
      (piece.start + piece.end) / 2 - bandCenter,
    );
    if (
      span > bestSpan ||
      (span === bestSpan && centerDistance < bestCenterDistance)
    ) {
      bestSpan = span;
      bestCenterDistance = centerDistance;
      bestIndex = index;
    }
  }
  if (bestIndex < 0) return null;

  const piece = band.pieces[bestIndex]!;
  const id = Math.floor((piece.start + piece.end) / 2);
  const remaining: FreeRange[] = [];
  if (piece.start < id) remaining.push({ start: piece.start, end: id - 1 });
  if (id < piece.end) remaining.push({ start: id + 1, end: piece.end });
  band.pieces.splice(bestIndex, 1, ...remaining);
  return id;
}

function widestBand(bands: Band[]): Band | null {
  let best: Band | null = null;
  let bestSpan = -1;
  for (const band of bands) {
    for (const piece of band.pieces) {
      const span = piece.end - piece.start;
      if (span > bestSpan) {
        bestSpan = span;
        best = band;
      }
    }
  }
  return best;
}

// Choose one unused ID per equal-width band, plus spare IDs for bands that
// have nothing free left. Covering every band keeps the digest spread across
// the whole channel; splitting the widest free piece keeps later days from
// piling up next to earlier samples. Maximizing the minimum distance instead
// says nothing about the largest gap, so whole digests drifted into whichever
// region still had the widest holes, usually the newest messages.
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
  const freeCount = maxMessageId - usedSorted.length;
  if (freeCount <= 0) return [];
  if (freeCount <= requestedCount) {
    const all: number[] = [];
    let next = 1;
    for (const used of usedSorted) {
      for (let id = next; id < used; id += 1) all.push(id);
      next = used + 1;
    }
    for (let id = next; id <= maxMessageId; id += 1) all.push(id);
    return all;
  }

  const bands = buildBands(
    maxMessageId,
    requestedCount,
    buildFreeRanges(maxMessageId, usedSorted),
  );
  const selected: number[] = [];
  let remaining = requestedCount;
  for (const band of bands) {
    if (!band.pieces.length) continue;
    const id = takeBandPoint(band);
    if (id === null) continue;
    selected.push(id);
    remaining -= 1;
  }

  while (remaining > 0) {
    const band = widestBand(bands);
    if (!band) break;
    const id = takeBandPoint(band);
    if (id === null) break;
    selected.push(id);
    remaining -= 1;
  }

  return selected.sort((a, b) => a - b);
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
