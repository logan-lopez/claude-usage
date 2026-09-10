/** Developer-only, manual refresh. Never imported by shipped code or scheduled.
 * Download the source, review its rates, then supply a curated snapshot with
 * --rates <json>. HTML changes must not silently corrupt monetary rates.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const source = "https://platform.claude.com/docs/en/about-claude/pricing";
const response = await fetch(source);
if (!response.ok)
  throw new Error(`pricing source returned HTTP ${response.status}`);
const text = await response.text();
mkdirSync(".context", { recursive: true });
await Bun.write(".context/pricing-source.html", text);
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(
    "Downloaded .context/pricing-source.html. Review rates, then rerun with --rates <curated-snapshot.json>. Committed snapshot unchanged.",
  );
} else {
  if (args.length !== 2 || args[0] !== "--rates")
    throw new Error(
      "usage: bun run tools/refresh-pricing.ts [--rates <curated-snapshot.json>]",
    );
  const candidate = await Bun.file(resolve(args[1]!)).json();
  if (
    !candidate.models ||
    typeof candidate.effective_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.effective_at))
  )
    throw new Error("snapshot requires models and effective_at date");
  for (const [model, speeds] of Object.entries(candidate.models)) {
    if (!model.startsWith("claude-") || !speeds || typeof speeds !== "object")
      throw new Error("invalid model entry");
    for (const rates of Object.values(speeds))
      for (const key of ["input", "output", "cache_creation", "cache_read"]) {
        const rate = (rates as Record<string, unknown>)[key];
        if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)
          throw new Error(`invalid ${model} ${key} rate`);
      }
  }
  if (!Object.keys(candidate.models).length)
    throw new Error("empty model table");
  await Bun.write(
    "src/pricing-snapshot.json",
    JSON.stringify(
      {
        ...candidate,
        source,
        source_url: source,
        fetched_at: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Updated src/pricing-snapshot.json; review the diff and run bun test.",
  );
}
