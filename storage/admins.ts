import { resolve } from "node:path";
import { readTextFile, replaceTextFile, SerialQueue } from "./text-file.js";

/** Share one instance across /start handlers and await load() at startup. */
export class AdminStore {
  private readonly path: string;
  private readonly configuredIds: ReadonlySet<number>;
  private readonly queue = new SerialQueue();
  private persistedIds = new Set<number>();

  constructor(path: string, configuredIds: ReadonlySet<number>) {
    this.path = resolve(path);
    this.configuredIds = new Set(configuredIds);
  }

  async load(): Promise<void> {
    return this.queue.run(async () => {
      const contents = await readTextFile(this.path);
      const next = new Set<number>();
      for (const line of contents.split(/\r?\n/)) {
        const raw = line.trim();
        if (!raw) continue;
        const id = Number(raw);
        if (Number.isInteger(id) && id > 0) next.add(id);
      }
      this.persistedIds = next;
    });
  }

  isGlobal(id: number): boolean {
    return this.configuredIds.has(id) || this.persistedIds.has(id);
  }

  hasAny(): boolean {
    return this.configuredIds.size > 0 || this.persistedIds.size > 0;
  }

  async bootstrapFirst(id: number): Promise<boolean> {
    return this.queue.run(async () => {
      if (this.hasAny()) return false;
      await replaceTextFile(this.path, `${id}\n`);
      this.persistedIds = new Set([id]);
      return true;
    });
  }
}
