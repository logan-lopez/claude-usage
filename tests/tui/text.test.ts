import { expect, test } from "bun:test";
import stringWidth from "string-width";
import { wrap } from "../../src/tui/text.ts";

test("wrap breaks prose at spaces, and only breaks a word wider than the line", () => {
  expect(wrap("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"]);
  expect(wrap("abcdefghijklmnop qr", 5)).toEqual(["abcde", "fghij", "klmno", "p qr"]);
  expect(wrap("ends with space ", 15)).toEqual(["ends with space"]);
  expect(wrap("", 5)).toEqual([""]);
  for (const row of wrap("👩‍💻👩‍💻 界界界 abc def", 5)) expect(stringWidth(row)).toBeLessThanOrEqual(5);
});
