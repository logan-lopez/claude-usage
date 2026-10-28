import { expect, test } from "bun:test";
import { BOOKS, TOKENS_PER_WORD, bookLine } from "../../src/tui/books.ts";

const tokens = (words: number) => words * TOKENS_PER_WORD;

test("bookLine names the largest book the tokens cover once, a fraction below the smallest, multiples past the largest", () => {
  expect(BOOKS.map((b) => b.words)).toEqual([...BOOKS.map((b) => b.words)].sort((a, b) => a - b));
  for (const [i, book] of BOOKS.entries()) {
    // At the threshold, this book; just under it, the one before.
    expect(bookLine(tokens(book.words))).toBe(`≈ 1.0 × ${book.title}`);
    if (i) expect(bookLine(tokens(book.words) - 1)).toEndWith(`× ${BOOKS[i - 1]!.title}`);
  }
  expect(bookLine(tokens(47_000 * 3.2))).toBe("≈ 3.2 × The Great Gatsby");
  expect(bookLine(tokens(12_000))).toBe("≈ 0.4 × Of Mice and Men");
  expect(bookLine(tokens(600))).toBe("≈ 0.02 × Of Mice and Men");
  expect(bookLine(0)).toBe("≈ 0.0 × Of Mice and Men");
  expect(bookLine(tokens(565_000 * 23.4))).toBe("≈ 23 × War and Peace");
  expect(bookLine(tokens(565_000 * 1234))).toBe("≈ 1,234 × War and Peace");
});
