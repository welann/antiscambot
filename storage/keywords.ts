import { resolve } from "node:path";
import { readTextFile, replaceTextFile, SerialQueue } from "./text-file.js";

export type AddKeywordResult = {
  added: boolean;
  keyword?: string | undefined;
  reason?: "empty" | "exists";
};

export type RemoveKeywordResult = {
  removed: boolean;
  keyword?: string;
  reason?: "empty" | "missing";
};

/** One shared instance owns the bot's global keywords; call load() at startup. */
export class KeywordStore {
  private readonly path: string;
  private readonly queue = new SerialQueue();
  private keywords = new Map<string, string>();
  private entries: [string, string][] = [];

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<void> {
    return this.queue.run(async () => {
      const contents = await readTextFile(this.path);
      const next = new Map<string, string>();
      for (const line of contents.split(/\r?\n/)) {
        const raw = line.trim();
        if (!raw) continue;
        const canonical = raw.toLowerCase();
        if (!next.has(canonical)) next.set(canonical, raw);
      }
      this.publish(next);
    });
  }

  async add(input: string): Promise<AddKeywordResult> {
    const raw = input.trim();
    if (!raw) return { added: false, reason: "empty" };
    const canonical = raw.toLowerCase();
    return this.queue.run(async () => {
      if (this.keywords.has(canonical)) {
        return { added: false, reason: "exists", keyword: this.keywords.get(canonical) };
      }
      const next = new Map(this.keywords);
      next.set(canonical, raw);
      await this.persist(next);
      return { added: true, keyword: raw };
    });
  }

  async remove(input: string): Promise<RemoveKeywordResult> {
    const raw = input.trim();
    if (!raw) return { removed: false, reason: "empty" };
    const canonical = raw.toLowerCase();
    return this.queue.run(async () => {
      const keyword = this.keywords.get(canonical);
      if (keyword === undefined) return { removed: false, reason: "missing" };
      const next = new Map(this.keywords);
      next.delete(canonical);
      await this.persist(next);
      return { removed: true, keyword };
    });
  }

  async clear(): Promise<number> {
    return this.queue.run(async () => {
      const count = this.keywords.size;
      await this.persist(new Map());
      return count;
    });
  }

  list(): string[] {
    return Array.from(this.keywords.values());
  }

  find(text: string): string | null {
    const haystack = text.toLowerCase();
    for (const [canonical, raw] of this.entries) {
      if (haystack.includes(canonical)) return raw;
    }
    return null;
  }

  private async persist(next: Map<string, string>): Promise<void> {
    const lines = Array.from(next.values());
    await replaceTextFile(this.path, lines.join("\n") + (lines.length ? "\n" : ""));
    this.publish(next);
  }

  private publish(next: Map<string, string>): void {
    this.keywords = next;
    this.entries = Array.from(next.entries()).sort((a, b) => b[0].length - a[0].length);
  }
}
