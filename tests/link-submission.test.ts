import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatLinkSubmissionChunks,
  parseLinkSubmissionInput,
  formatLinkSubmissionMessage,
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

describe("links mixed with commentary", () => {
  const link = "做市商怎么挂单（期权ver） (https://telegra.ph/做市商怎么挂单期权ver-10-07) | 原文 (https://zhuanlan.zhihu.com/p/2090947232493204386)";
  const expected = '<a href="https://telegra.ph/做市商怎么挂单期权ver-10-07">做市商怎么挂单（期权ver）</a> | <a href="https://zhuanlan.zhihu.com/p/2090947232493204386">原文</a>';

  test("keeps same-line commentary and hashtags outside the article link", () => {
    const result = formatLinkSubmissionMessage(`这篇文章得看看#做市 ${link}`);
    assert.equal(result?.html, `这篇文章得看看#做市\n${expected}`);
    assert.equal(result?.count, 1);
    assert.equal(formatLinkSubmissionMessage(`看看#做市 #期权 ${link}`)?.html,
      `看看#做市 #期权\n${expected}`);
  });

  test("preserves separate commentary, blank lines and trailing notes", () => {
    const result = formatLinkSubmissionMessage(`这篇 <文章> & #做市\n\n${link}\n读后再讨论`);
    assert.equal(result?.html, `这篇 &lt;文章&gt; &amp; #做市\n\n${expected}\n读后再讨论`);
    assert.equal(result?.chunks[0], result?.html);
  });

  test("normalizes escaped URL colons and preserves multi-word titles", () => {
    assert.equal(formatLinkSubmissionMessage(link.replaceAll("https:", "https\\:"))?.html, expected);
    assert.match(formatLinkSubmissionMessage("An article title (https://telegra.ph/a) | 原文 (https://example.com/a)")!.html,
      />An article title<\/a>/);
  });

  test("ignores ordinary messages and already converted text", () => {
    for (const text of ["随便聊聊#做市", "标题 | 原文", "https://telegra.ph/a", ""]) {
      assert.equal(formatLinkSubmissionMessage(text), null);
    }
  });

  test("does not silently discard malformed entries in a mixed submission", () => {
    assert.throws(() => formatLinkSubmissionMessage(`${link}\n坏链接 (javascript:alert) | 原文 (https://example.com)`));
    assert.throws(() => formatLinkSubmissionMessage(link, 10), /长度限制/);
  });
});
