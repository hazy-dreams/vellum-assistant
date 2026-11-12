/**
 * Split a reply into the texts a person would send.
 *
 * On iMessage a paragraph is a message: someone texting writes a thought, sends
 * it, writes the next. So the home line delivers each paragraph as its own
 * text rather than one long bubble.
 *
 * What counts as one text:
 * - Blank lines separate texts.
 * - A fenced code block is one text however many blank lines it contains,
 *   because splitting it would scatter the code across bubbles.
 * - A list stays in one text even when its items are spaced apart, because a
 *   list reads as one thought and a bubble per item reads as spam.
 * - A paragraph longer than `maxChars` is cut at sentence boundaries, then at
 *   word boundaries, never mid-word, so no single text runs past what reads
 *   comfortably on a phone.
 *
 * Pure and deterministic: the delivery loop persists how many of these it has
 * sent and resumes from that index on retry, so the same input must always
 * split the same way.
 */

export const DEFAULT_MAX_TEXT_CHARS = 1200;

const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;

function isListBlock(block: string): boolean {
  const lines = block.split("\n").filter((line) => line.trim().length > 0);
  return lines.length > 0 && LIST_ITEM.test(lines[0]!);
}

/** Group lines into blank-line-separated blocks, keeping fences whole. */
function blocksOf(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const block = current.join("\n").replace(/^\n+|\n+$/g, "");
    if (block.trim().length > 0) {
      blocks.push(block);
    }
    current = [];
  };

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      current.push(line);
      if (marker === fence) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      current.push(line);
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    current.push(line);
  }
  // An unclosed fence still ends at the end of the reply.
  flush();
  return blocks;
}

/** Merge runs of list blocks back into one block. */
function joinLists(blocks: string[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    const previous = out[out.length - 1];
    if (previous !== undefined && isListBlock(previous) && isListBlock(block)) {
      out[out.length - 1] = `${previous}\n${block}`;
    } else {
      out.push(block);
    }
  }
  return out;
}

/** Cut text at the last boundary at or before `limit`, by preference order. */
function cutPoint(text: string, limit: number): number {
  const window = text.slice(0, limit + 1);
  const sentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
    window.lastIndexOf("\n"),
  );
  if (sentence > limit / 3) {
    return sentence + 1;
  }
  const space = window.lastIndexOf(" ");
  if (space > 0) {
    return space;
  }
  // A single token longer than the limit (a long URL): cut it whole rather
  // than break it, and let it be one oversized text.
  const next = text.indexOf(" ", limit);
  return next === -1 ? text.length : next;
}

function chunk(block: string, maxChars: number): string[] {
  // Code is never cut: a half code block is worse than a long text.
  if (FENCE.test(block)) {
    return [block];
  }
  const out: string[] = [];
  let rest = block;
  while (rest.length > maxChars) {
    const at = cutPoint(rest, maxChars);
    const head = rest.slice(0, at).trim();
    if (head.length === 0) {
      break;
    }
    out.push(head);
    rest = rest.slice(at).trim();
  }
  if (rest.length > 0) {
    out.push(rest);
  }
  return out;
}

/**
 * The texts one reply becomes, in send order. Never returns an empty string;
 * returns an empty array for a reply with nothing visible in it.
 */
export function splitIntoTexts(
  text: string,
  maxChars: number = DEFAULT_MAX_TEXT_CHARS,
): string[] {
  return joinLists(blocksOf(text)).flatMap((block) => chunk(block, maxChars));
}
