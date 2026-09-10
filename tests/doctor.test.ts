import { test, expect } from "bun:test";
import { openDb } from "../src/schema.ts";
import { doctor } from "../src/doctor.ts";

test("doctor checks operational evidence without leaking credentials or contacting services", async () => {
  const db = openDb(":memory:");
  try {
    const result = await doctor(db, "fake", {
      deps: {
        now: 10_000_000,
        launch: async () => ({ loaded: true, lastExit: 7 }),
        credential: async () => true,
        exists: () => false,
        transcriptPresent: () => false,
        size: () => 1234,
        head: () => "abc",
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.checks.find((c) => c.name === "credential")?.detail).toBe(
      "reachable",
    );
    expect(result.checks.find((c) => c.name === "requests")?.level).toBe(
      "broken",
    );
    expect(result.checks.find((c) => c.name === "integrity")?.level).toBe("ok");
    expect(result.checks[0]?.detail).toContain("7");
  } finally {
    db.close();
  }
});
