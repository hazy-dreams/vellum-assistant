import { describe, expect, it } from "bun:test";

import { splitIntoTexts } from "./paragraphs.js";

describe("splitIntoTexts", () => {
  it("sends each paragraph as its own text", () => {
    expect(
      splitIntoTexts(
        "hey, you up?\n\nfound the vacuum box downstairs.\n\nit's huge",
      ),
    ).toEqual([
      "hey, you up?",
      "found the vacuum box downstairs.",
      "it's huge",
    ]);
  });

  it("keeps a single-line-break paragraph together", () => {
    expect(splitIntoTexts("line one\nline two\n\nnext")).toEqual([
      "line one\nline two",
      "next",
    ]);
  });

  it("ignores extra blank lines, trailing space and CRLF", () => {
    expect(splitIntoTexts("\r\n\r\na\r\n\r\n\r\n\r\nb\n\n   \n")).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns nothing for an empty reply", () => {
    expect(splitIntoTexts("")).toEqual([]);
    expect(splitIntoTexts("  \n\n \n")).toEqual([]);
  });

  it("keeps a fenced code block whole across its blank lines", () => {
    const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    expect(splitIntoTexts(`here:\n\n${code}\n\nthat's it`)).toEqual([
      "here:",
      code,
      "that's it",
    ]);
  });

  it("keeps an unclosed fence as one block to the end", () => {
    expect(splitIntoTexts("x\n\n```\na\n\nb")).toEqual(["x", "```\na\n\nb"]);
  });

  it("keeps a spaced-out list in one text", () => {
    expect(
      splitIntoTexts(
        "to do:\n\n- feed archie\n\n- feed luna\n\n1. sleep\n\nok",
      ),
    ).toEqual(["to do:", "- feed archie\n- feed luna\n1. sleep", "ok"]);
  });

  it("cuts a long paragraph at sentence boundaries", () => {
    const sentence = "This sentence is about forty characters. ";
    const texts = splitIntoTexts(sentence.repeat(10).trim(), 100);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(100);
      expect(text.endsWith(".")).toBe(true);
    }
    expect(texts.join(" ")).toBe(sentence.repeat(10).trim());
  });

  it("falls back to word boundaries and never cuts mid-word", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const texts = splitIntoTexts(words, 50);
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(50);
    }
    expect(texts.join(" ")).toBe(words);
  });

  it("does not break a single token longer than the limit", () => {
    const url = `https://example.com/${"a".repeat(80)}`;
    expect(splitIntoTexts(`see ${url} later`, 40)).toEqual([
      "see",
      url,
      "later",
    ]);
  });

  it("never cuts code even when it is long", () => {
    const code = `\`\`\`\n${"x".repeat(300)}\n\`\`\``;
    expect(splitIntoTexts(code, 50)).toEqual([code]);
  });

  it("is deterministic, so retries resume at the same index", () => {
    const reply = "a\n\nb\n\n- c\n\n- d\n\n```\ne\n\nf\n```\n\ng";
    expect(splitIntoTexts(reply)).toEqual(splitIntoTexts(reply));
  });
});
