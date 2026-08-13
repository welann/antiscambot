import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatLinkSubmissionChunks,
  parseLinkSubmissionInput,
} from "../link-submission.js";

describe("link submission formatting", () => {
  test("parses multiple fixed-format links into Telegram HTML", () => {
    const entries = parseLinkSubmissionInput(
      "“落到美国人手上，是日本民族最大的幸运”，这句话说得对吗？ (https://telegra.ph/落到美国人手上是日本民族最大的幸运这句话说得对吗-08-13) | 原文 (https://www.zhihu.com/question/2068450586501108139/answer/2070592166431347179)\n\n如何评价《献给阿尔吉侬的花束》这本书？ (https://telegra.ph/如何评价献给阿尔吉侬的花束这本书-08-13) | 原文 (https://www.zhihu.com/question/21128291/answer/2726035289)",
    );

    assert.deepEqual(entries, [
      {
        title: "“落到美国人手上，是日本民族最大的幸运”，这句话说得对吗？",
        articleUrl: "https://telegra.ph/落到美国人手上是日本民族最大的幸运这句话说得对吗-08-13",
        sourceUrl: "https://www.zhihu.com/question/2068450586501108139/answer/2070592166431347179",
      },
      {
        title: "如何评价《献给阿尔吉侬的花束》这本书？",
        articleUrl: "https://telegra.ph/如何评价献给阿尔吉侬的花束这本书-08-13",
        sourceUrl: "https://www.zhihu.com/question/21128291/answer/2726035289",
      },
    ]);
    assert.deepEqual(formatLinkSubmissionChunks(entries), [
      '<a href="https://telegra.ph/落到美国人手上是日本民族最大的幸运这句话说得对吗-08-13">“落到美国人手上，是日本民族最大的幸运”，这句话说得对吗？</a> | <a href="https://www.zhihu.com/question/2068450586501108139/answer/2070592166431347179">原文</a>\n<a href="https://telegra.ph/如何评价献给阿尔吉侬的花束这本书-08-13">如何评价《献给阿尔吉侬的花束》这本书？</a> | <a href="https://www.zhihu.com/question/21128291/answer/2726035289">原文</a>',
    ]);
  });

  test("escapes HTML and rejects malformed lines", () => {
    const entries = parseLinkSubmissionInput(
      "A & B <C> (https://telegra.ph/a?x=1&y=2) | 原文 (https://www.zhihu.com/question/1?foo=bar&baz=qux)",
    );
    assert.deepEqual(formatLinkSubmissionChunks(entries), [
      '<a href="https://telegra.ph/a?x=1&amp;y=2">A &amp; B &lt;C&gt;</a> | <a href="https://www.zhihu.com/question/1?foo=bar&amp;baz=qux">原文</a>',
    ]);
    assert.throws(
      () => parseLinkSubmissionInput("标题 (https://telegra.ph/a) | 原文 https://www.zhihu.com/question/1"),
      /第 1 行格式错误/,
    );
  });

  test("splits long submissions only at entry boundaries", () => {
    const entries = parseLinkSubmissionInput(
      "条目一 (https://telegra.ph/one) | 原文 (https://www.zhihu.com/question/one)\n条目二 (https://telegra.ph/two) | 原文 (https://www.zhihu.com/question/two)",
    );
    const chunks = formatLinkSubmissionChunks(entries, 100);

    assert.equal(chunks.length, 2);
    assert.ok(chunks.every((chunk) => chunk.length <= 100));
  });
});
