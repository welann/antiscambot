import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { KeywordStore } from "../storage/keywords.js";
import { AdminStore } from "../storage/admins.js";

async function fixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "antiscambot-storage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("keywords load legacy TXT, preserve first spelling and match longest case-insensitively", async t => {
  const path = join(await fixture(t), "keywords.txt");
  await writeFile(path, "  Scam  \r\n\r\nSCAM\nScam Link\nother\n");
  const store = new KeywordStore(path);
  await store.load();
  assert.deepEqual(store.list(), ["Scam", "Scam Link", "other"]);
  assert.equal(store.find("a SCAM LINK and OTHER"), "Scam Link");
  assert.equal(store.find("safe text"), null);
  const copy = store.list();
  copy.length = 0;
  assert.equal(store.find("scam"), "Scam");
  assert.equal(store.list().length, 3);
});

test("keyword mutations keep old result shapes and survive restart", async t => {
  const path = join(await fixture(t), "nested", "keywords.txt");
  const store = new KeywordStore(path);
  await store.load();
  assert.equal(await readFile(path, "utf8"), "");
  assert.deepEqual(await store.add(" \n "), { added: false, reason: "empty" });
  assert.deepEqual(await store.add("  Scam  "), { added: true, keyword: "Scam" });
  assert.deepEqual(await store.add("sCAM"), { added: false, reason: "exists", keyword: "Scam" });
  assert.deepEqual(await store.remove("  "), { removed: false, reason: "empty" });
  assert.deepEqual(await store.remove("missing"), { removed: false, reason: "missing" });
  await store.add("Other");
  assert.deepEqual(await store.remove(" SCAM "), { removed: true, keyword: "Scam" });
  assert.equal(store.find("scam"), null);
  assert.equal(await readFile(path, "utf8"), "Other\n");
  const restarted = new KeywordStore(path);
  await restarted.load();
  assert.deepEqual(restarted.list(), ["Other"]);
  assert.equal(await restarted.clear(), 1);
  assert.equal(await restarted.clear(), 0);
  await store.load();
  assert.deepEqual(store.list(), []);
  assert.equal(store.find("other"), null);
  assert.equal(await readFile(path, "utf8"), "");
});

test("concurrent load/add/remove/clear execute in invocation order without lost updates", async t => {
  const path = join(await fixture(t), "keywords.txt");
  const store = new KeywordStore(path);
  const results = await Promise.all([
    store.load(), store.add("Alpha"), store.add("ALPHA"), store.add("Beta"),
    store.remove("alpha"), store.add("Gamma"), store.clear(),
    store.add("Final"), store.remove("Beta"),
  ]);
  assert.deepEqual(results, [
    undefined, { added: true, keyword: "Alpha" },
    { added: false, reason: "exists", keyword: "Alpha" },
    { added: true, keyword: "Beta" }, { removed: true, keyword: "Alpha" },
    { added: true, keyword: "Gamma" }, 2, { added: true, keyword: "Final" },
    { removed: false, reason: "missing" },
  ]);
  assert.deepEqual(store.list(), ["Final"]);
  const restarted = new KeywordStore(path);
  await restarted.load();
  assert.deepEqual(restarted.list(), ["Final"]);
});

for (const operation of ["add", "remove", "clear"] as const) {
  test(`failed keyword ${operation} preserves memory and allows queue recovery`, async t => {
    const dir = await fixture(t);
    const path = join(dir, "keywords.txt");
    const backup = join(dir, "saved.txt");
    await writeFile(path, "Original\n");
    const store = new KeywordStore(path);
    await store.load();
    await rename(path, backup);
    await mkdir(path);
    const mutation = operation === "clear" ? store.clear() : store[operation](operation === "add" ? "New" : "original");
    await assert.rejects(mutation);
    assert.deepEqual(store.list(), ["Original"]);
    assert.equal(store.find("ORIGINAL"), "Original");
    assert.equal(store.find("New"), null);
    assert.equal(await readFile(backup, "utf8"), "Original\n");
    assert.deepEqual((await readdir(dir)).sort(), ["keywords.txt", "saved.txt"]);
    await rm(path, { recursive: true });
    await rename(backup, path);
    assert.deepEqual(await store.add("Recovered"), { added: true, keyword: "Recovered" });
    const restarted = new KeywordStore(path);
    await restarted.load();
    assert.deepEqual(restarted.list(), ["Original", "Recovered"]);
  });
}

test("failure creating a temporary file does not publish keyword state or poison queued operations", async t => {
  const dir = await fixture(t);
  const parent = join(dir, "data");
  const saved = join(dir, "saved");
  const path = join(parent, "keywords.txt");
  const store = new KeywordStore(path);
  await store.load();
  await store.add("Original");
  await rename(parent, saved);
  await writeFile(parent, "not a directory");
  const results = await Promise.allSettled([store.add("Lost"), store.remove("Original"), store.clear()]);
  assert.deepEqual(results.map(result => result.status), ["rejected", "rejected", "rejected"]);
  assert.deepEqual(store.list(), ["Original"]);
  await rm(parent);
  await rename(saved, parent);
  await store.add("Recovered");
  assert.equal(await readFile(path, "utf8"), "Original\nRecovered\n");
});

test("keyword persistence replaces the file rather than truncating the old inode", async t => {
  const dir = await fixture(t);
  const path = join(dir, "keywords.txt");
  const snapshot = join(dir, "snapshot.txt");
  await writeFile(path, "Original\n");
  await link(path, snapshot);
  const store = new KeywordStore(path);
  await store.load();
  await store.add("New");
  assert.equal(await readFile(snapshot, "utf8"), "Original\n");
  assert.equal(await readFile(path, "utf8"), "Original\nNew\n");
});

test("admins combine configured IDs and valid legacy file IDs without persisting configuration", async t => {
  const path = join(await fixture(t), "admins.txt");
  const contents = " 42\r\n42\n0\n-1\n1.5\ninvalid\nInfinity\n100\n";
  await writeFile(path, contents);
  const store = new AdminStore(path, new Set([7]));
  assert.equal(store.isGlobal(7), true);
  await store.load();
  assert.equal(store.hasAny(), true);
  for (const id of [7, 42, 100]) assert.equal(store.isGlobal(id), true);
  for (const id of [0, -1, 1.5, 8, Infinity]) assert.equal(store.isGlobal(id), false);
  assert.equal(await store.bootstrapFirst(9), false);
  assert.equal(await readFile(path, "utf8"), contents);
  const restarted = new AdminStore(path, new Set());
  await restarted.load();
  assert.equal(restarted.isGlobal(7), false);
  assert.equal(restarted.isGlobal(42), true);
  assert.equal(await restarted.bootstrapFirst(9), false);
});

test("configured administrator alone prevents bootstrap", async t => {
  const path = join(await fixture(t), "admins.txt");
  const store = new AdminStore(path, new Set([7]));
  await store.load();
  assert.equal(store.hasAny(), true);
  assert.equal(await store.bootstrapFirst(9), false);
  assert.equal(store.isGlobal(9), false);
  assert.equal(await readFile(path, "utf8"), "");
});

test("concurrent first starts have exactly one winner and recover that winner after restart", async t => {
  const path = join(await fixture(t), "nested", "admins.txt");
  const store = new AdminStore(path, new Set());
  assert.equal(store.hasAny(), false);
  const loading = store.load();
  const starts = Array.from({ length: 30 }, (_, i) => store.bootstrapFirst(i + 1));
  await loading;
  assert.deepEqual(await Promise.all(starts), [true, ...Array(29).fill(false)]);
  assert.equal(store.isGlobal(1), true);
  assert.equal(store.isGlobal(2), false);
  assert.equal(await readFile(path, "utf8"), "1\n");
  const restarted = new AdminStore(path, new Set());
  await restarted.load();
  assert.equal(restarted.hasAny(), true);
  assert.equal(restarted.isGlobal(1), true);
  assert.equal(await restarted.bootstrapFirst(2), false);
});

test("failed admin persistence does not grant access and bootstrap can retry", async t => {
  const dir = await fixture(t);
  const path = join(dir, "admins.txt");
  const backup = join(dir, "saved.txt");
  const store = new AdminStore(path, new Set());
  await store.load();
  await rename(path, backup);
  await mkdir(path);
  await assert.rejects(store.bootstrapFirst(1));
  assert.equal(store.hasAny(), false);
  assert.equal(store.isGlobal(1), false);
  assert.equal(await readFile(backup, "utf8"), "");
  assert.deepEqual((await readdir(dir)).sort(), ["admins.txt", "saved.txt"]);
  await rm(path, { recursive: true });
  await rename(backup, path);
  assert.deepEqual(await Promise.all([store.bootstrapFirst(2), store.bootstrapFirst(3)]), [true, false]);
  assert.equal(store.isGlobal(1), false);
  assert.equal(store.isGlobal(2), true);
  assert.equal(await readFile(path, "utf8"), "2\n");
});

test("failed reload preserves loaded keyword and admin state and both queues recover", async t => {
  const dir = await fixture(t);
  const keywordPath = join(dir, "keywords.txt");
  const adminPath = join(dir, "admins.txt");
  await writeFile(keywordPath, "Original\n");
  await writeFile(adminPath, "42\n");
  const keywords = new KeywordStore(keywordPath);
  const admins = new AdminStore(adminPath, new Set([7]));
  await Promise.all([keywords.load(), admins.load()]);
  for (const path of [keywordPath, adminPath]) {
    await rename(path, path + ".saved");
    await mkdir(path);
  }
  await assert.rejects(keywords.load());
  await assert.rejects(admins.load());
  assert.deepEqual(keywords.list(), ["Original"]);
  assert.equal(admins.isGlobal(42), true);
  assert.equal(admins.isGlobal(7), true);
  for (const path of [keywordPath, adminPath]) {
    await rm(path, { recursive: true });
    await rename(path + ".saved", path);
  }
  await writeFile(keywordPath, "Changed\n");
  await writeFile(adminPath, "99\n");
  await Promise.all([keywords.load(), admins.load()]);
  assert.deepEqual(keywords.list(), ["Changed"]);
  assert.equal(admins.isGlobal(42), false);
  assert.equal(admins.isGlobal(99), true);
});
