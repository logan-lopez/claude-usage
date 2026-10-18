import { expect, test } from "bun:test";
import stringWidth from "string-width";
import { num, spark, wrap } from "../../src/tui/text.ts";
import { sparkline } from "../../src/format.ts";

test("wrap breaks prose at spaces, and only breaks a word wider than the line", () => {
  expect(wrap("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"]);
  expect(wrap("abcdefghijklmnop qr", 5)).toEqual(["abcde", "fghij", "klmno", "p qr"]);
  expect(wrap("ends with space ", 15)).toEqual(["ends with space"]);
  expect(wrap("", 5)).toEqual([""]);
  for (const row of wrap("👩‍💻👩‍💻 界界界 abc def", 5)) expect(stringWidth(row)).toBeLessThanOrEqual(5);
});

test("num rounds before it picks a unit, so 999,999 reads 1.0M", () => {
  expect(num(999)).toBe("999");
  expect(num(999_949)).toBe("999.9K");
  expect(num(999_999)).toBe("1.0M");
  expect(num(77_600_000)).toBe("77.6M");
});

test("the explorer's sparkline draws the same glyphs as cusage limits --history", () => {
  const readings = [0, 7, 50, 93, 100];
  expect(spark(readings)).toBe(sparkline(readings));
  expect(spark([50])).toBe("▅");
  expect(spark([null])).toBe("·");
});
