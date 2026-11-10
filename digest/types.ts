export const MAX_DIGEST_SAMPLE_SIZE = 100;

export const MAX_TELEGRAM_MESSAGE_ID = 2_147_483_647;

export type LinkKind = "public" | "private";

export type DigestTrigger = "manual" | "scheduled";

export interface ParsedTelegramMessageLink {
  chatReference: string | number;
  linkKind: LinkKind;
  linkChannel: string;
  messageId: number;
}

export interface SourceChannel {
  chatId: number;
  title: string;
  username: string | null;
  linkKind: LinkKind;
  linkChannel: string;
  latestMessageId: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SourceChannelInput {
  chatId: number;
  title: string;
  username: string | null;
  linkKind: LinkKind;
  linkChannel: string;
  latestMessageId: number;
}

export interface SourceChannelStats extends SourceChannel {
  usedCount: number;
  remainingCount: number;
}

export interface TargetChannel {
  chatId: number;
  title: string;
  username: string | null;
  linkKind: LinkKind;
  linkChannel: string;
  updatedAt: string;
}

export interface TargetChannelInput {
  chatId: number;
  title: string;
  username: string | null;
  linkKind: LinkKind;
  linkChannel: string;
}

export interface LinkSubmissionTarget {
  chatId: number;
  title: string;
}

export interface LinkSubmissionTargetInput {
  chatId: number;
  title: string;
}

export interface DigestRuntimeConfig {
  cronExpression: string;
  timeZone: string;
  sampleSize: number;
}

export interface DigestSelection {
  sourceChatId: number;
  sourceMessageId: number;
  sourceTitle: string;
  messageLink: string;
}

export interface DigestSection {
  source: SourceChannel;
  selections: DigestSelection[];
}

export interface DigestChunk {
  html: string;
  selections: DigestSelection[];
}

export interface DigestSendResult {
  messageId: number;
}

export type DigestSender = (
  targetChatId: number,
  html: string,
) => Promise<DigestSendResult>;

export interface DigestRunResult {
  status:
    | "sent"
    | "empty"
    | "busy"
    | "already-ran"
    | "not-configured"
    | "failed";
  itemCount: number;
  messageCount: number;
  error: string | null;
}

export interface DigestServiceOptions {
  sendMaxAttempts?: number;
  retryDelayMs?: number;
}
