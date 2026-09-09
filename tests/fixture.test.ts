import { expect, test } from "bun:test";
import { findTranscripts } from "../src/ingest.ts";
import { FIXTURES, FIXTURE_TRANSCRIPTS, manifest } from "./helpers.ts";

// A baseline that drifts trains everyone to ignore a failing test, so the
// fixture bytes are pinned. If this fails, someone regenerated the fixture --
// which is allowed, but BASELINE.json has to be regenerated with it.
test("fixture checksums match the manifest", async () => {
  for (const [rel, expected] of Object.entries<string>(manifest.files)) {
    const bytes = new Uint8Array(await Bun.file(`${FIXTURES}/${rel}`).arrayBuffer());
    const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(`${rel}:${actual}`).toBe(`${rel}:${expected}`);
  }
});

test("fixture covers every hard case the ingester has to handle", () => {
  expect(manifest.traitsMissing).toEqual([]);
  expect(manifest.traitsCovered).toContain("no_request_id");
  expect(manifest.traitsCovered).toContain("dup_key");
  expect(manifest.traitsCovered).toContain("cross_file_session");
  expect(manifest.traitsCovered).toContain("subagent_file");
  expect(manifest.traitsCovered).toContain("cost_state_opus_1m");
});

// The fixture is committed to a repo. This is the test that keeps it safe to
// commit, and it runs on every `bun test` rather than once at generation time.
test("fixture contains no personal data", async () => {
  const parts: string[] = [];
  for (const f of findTranscripts(FIXTURE_TRANSCRIPTS)) parts.push(await Bun.file(f).text());
  for (const p of ["claude.json", "plan-usage-history.json", "glaze-usage-history.json"]) {
    parts.push(await Bun.file(`${FIXTURES}/${p}`).text());
  }
  const blob = parts.join("\n");

  const forbidden: [string, RegExp][] = [
    ["absolute home path", /\/Users\/[a-z]/i],
    ["real message id", /msg_01[0-9A-Za-z]{12,}/],
    ["real request id", /req_01[0-9A-Za-z]{12,}/],
    ["real tool_use id", /toolu_01[0-9A-Za-z]{12,}/],
    ["email address", /[\w.+-]+@[\w-]+\.[a-z]{2,}/i],
    ["prose text field", /"text"\s*:\s*"(?!\[redacted\])[^"]{3,}"/],
    ["thinking content", /"thinking"\s*:\s*"(?!\[redacted\])[^"]{3,}"/],
    ["tool input", /"input"\s*:\s*\{\s*"/],
  ];
  for (const [name, re] of forbidden) {
    const hit = blob.match(re);
    expect(hit ? `${name}: ${hit[0].slice(0, 80)}` : null).toBeNull();
  }

  // Every UUID in the fixture must be one we minted.
  const foreign = [...new Set(blob.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])]
    .filter((u) => !/^(f1000000-0000|[0-9a-f]{8}-5e55|acc00000-0000|06900000-0000)-4000-8000-/.test(u));
  expect(foreign).toEqual([]);
});
