/** Operational checks; no network, no credential material in returned values. */
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { archiveHealth } from "./query.ts";
import { paths } from "./paths.ts";
import { readToken, redact } from "./oauth.ts";
import { build } from "./version.ts";
export interface Check {
  name: string;
  level: "ok" | "warning" | "broken";
  detail: string;
}
export interface DoctorDependencies {
  now: number;
  launch: (
    label: string,
  ) => Promise<{ loaded: boolean; lastExit: number | null }>;
  credential: () => Promise<boolean>;
  exists: (file: string) => boolean;
  transcriptPresent: () => boolean;
  size: (file: string) => number;
  head: (repo: string) => string | null;
}
const defaults: DoctorDependencies = {
  now: Date.now(),
  exists: existsSync,
  credential: async () => (await readToken()) !== null,
  transcriptPresent: () =>
    existsSync(paths.transcripts) && readdirSync(paths.transcripts).length > 0,
  size: (file) => statSync(file).size,
  head: (repo) => {
    const p = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  },
  launch: async (label) => {
    if (process.platform !== "darwin") return { loaded: false, lastExit: null };
    const p = Bun.spawn(
      ["launchctl", "print", `gui/${process.getuid!()}/${label}`],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(p.stdout).text();
    const match = /last exit code = (\d+)/.exec(out);
    return {
      loaded: (await p.exited) === 0,
      lastExit: match ? Number(match[1]) : null,
    };
  },
};
export async function doctor(
  db: Database,
  file: string,
  opts: { repo?: string; deps?: Partial<DoctorDependencies> } = {},
) {
  const deps = { ...defaults, now: Date.now(), ...opts.deps };
  const checks: Check[] = [];
  const add = (name: string, level: Check["level"], detail: string) =>
    checks.push({ name, level, detail: redact(detail) });
  for (const label of [
    "com.logan.claude-usage",
    "com.logan.claude-usage-limits",
  ]) {
    try {
      const agent = await deps.launch(label);
      add(
        label,
        !agent.loaded ? "broken" : agent.lastExit ? "broken" : "ok",
        !agent.loaded
          ? "not loaded"
          : `loaded; last exit ${agent.lastExit ?? "not recorded"}`,
      );
    } catch {
      add(label, "broken", "could not inspect launch agent");
    }
  }
  try {
    const health = archiveHealth(db);
    add(
      "integrity",
      health.integrity.length === 1 && health.integrity[0] === "ok"
        ? "ok"
        : "broken",
      health.integrity.join("; "),
    );
    for (const [name, latest, interval] of [
      ["requests", health.newestRequest, 3_600_000],
      ["limit_samples", health.newestLimit, 900_000],
    ] as const) {
      const age = latest === null ? null : deps.now - latest;
      add(
        name,
        age === null
          ? "broken"
          : age > interval * 2 || age < 0
            ? "broken"
            : "ok",
        `newest row ${age === null ? "absent" : `${Math.round(age / 60_000)}m ago`}; agent interval ${interval / 60_000}m (row age can also mean inactivity)`,
      );
    }
    const missing = health.trackedFiles.filter((file) => !deps.exists(file));
    add(
      "ingest_state",
      missing.length ? "warning" : "ok",
      `${missing.length} of ${health.trackedFiles.length} tracked source files no longer exist; archived rows retained`,
    );
  } catch {
    add("archive", "broken", "cannot read archive or run integrity check");
  }
  try {
    add("size", "ok", `${deps.size(file)} bytes`);
  } catch {
    add("size", "broken", "archive file unavailable");
  }
  const repo =
    opts.repo ?? process.env.CUSAGE_REPO ?? build.repo ?? process.cwd();
  const head = deps.head(repo);
  add(
    "build",
    !build.sha || !head || build.dirty || build.sha !== head ? "warning" : "ok",
    `binary ${build.sha ?? "source invocation"}; built ${build.builtAt ?? "unstamped"}${build.dirty ? " (dirty checkout)" : ""}; repo HEAD ${head ?? "unavailable"}`,
  );
  try {
    const present = await deps.credential();
    add(
      "credential",
      present ? "ok" : "broken",
      present ? "reachable" : "not found",
    );
  } catch {
    add("credential", "broken", "not reachable");
  }
  try {
    const present = deps.transcriptPresent();
    add(
      "transcripts",
      present ? "ok" : "broken",
      present ? "directory present and non-empty" : "missing or empty",
    );
  } catch {
    add("transcripts", "broken", "directory unreadable");
  }
  return {
    checkedAt: deps.now,
    build,
    repo,
    checks,
    exitCode: checks.some((c) => c.level === "broken")
      ? 2
      : checks.some((c) => c.level === "warning")
        ? 1
        : 0,
  };
}
