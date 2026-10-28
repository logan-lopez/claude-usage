/** Timeline's book line: output tokens as classic books. Approximate by design; no React, no I/O. */

/**
 * A common rule of thumb for English prose under BPE tokenizers, not a figure measured for Claude's
 * tokenizer, so the line always says ≈.
 */
export const TOKENS_PER_WORD = 1.3;

/**
 * Smallest first. Word counts differ by edition and translation (Moby-Dick 206,052–209,117, War and
 * Peace 544,000–587,000, per web sources checked 2026-10-28), so these are round figures inside them.
 */
export const BOOKS = [
  { title: "Of Mice and Men", words: 30_000 },
  { title: "The Great Gatsby", words: 47_000 },
  { title: "Moby-Dick", words: 207_000 },
  { title: "War and Peace", words: 565_000 },
] as const;

/**
 * `tokens` as a multiple of the largest book it covers at least once: `≈ 3.2 × The Great Gatsby`.
 * Below one Of Mice and Men it's a fraction of that; past War and Peace, multiples of it.
 */
export function bookLine(tokens: number): string {
  const words = Math.max(0, tokens) / TOKENS_PER_WORD;
  const book = [...BOOKS].reverse().find((b) => words >= b.words) ?? BOOKS[0];
  const times = words / book.words;
  const shown = times >= 10
    ? Math.round(times).toLocaleString("en-US")
    : times >= 0.1 || times === 0 ? times.toFixed(1) : times.toFixed(2);
  return `≈ ${shown} × ${book.title}`;
}
