#!/usr/bin/env bun
/**
 * Argument parsing and dispatch. Nothing else.
 *
 * This file must never import ./tui.ts, ink or react — not even lazily, for
 * now. The archiver runs hourly under launchd and the statusline may poll
 * `--json` several times a minute; neither may pay React's startup cost.
 * `cusage tui` is a separate bin target. See CLAUDE.md.
 */
import { openDb } from "./schema.ts";
import { ingestTranscripts } from "./ingest.ts";
import { type RefreshMode, refreshFromApi, syncLimits } from "./limits.ts";
import { paths } from "./paths.ts";
import { parseDuration, parseSince } from "./time.ts";
import * as q from "./query.ts";
import * as f from "./format.ts";

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
}

/**
 * Flags that consume the next argument. Everything else is a boolean.
 *
 * The rule used to be the opposite — any flag swallowed the next non-`--`
 * token — so `cusage --json status` set `json: "status"`, left no positional,
 * fell through to the help text and exited 0. No error, no requested output.
 * Putting global flags before the command is the natural way to type this and
 * it has to work.
 *
 * Registering a new value flag here is one line. Forgetting to means its
 * argument lands in `positional`, which is loud — the right direction for the
 * failure to point.
 */
const VALUE_FLAGS = new Set([
  "db", "transcripts", "since", "by", "limit", "project", "bucket",
]);

function parseArgs(argv: string[], valueFlags: Set<string> = VALUE_FLAGS): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (valueFlags.has(key) && next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command: positional.shift() ?? "help", positional, flags };
}

const str = (v: string | true | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * Explicit flag beats `$CUSAGE_REFRESH` beats the command's default.
 *
 * There is deliberately no way to spell "ignore the guard". `force` skips the
 * staleness check and nothing else; the 3-minute floor lives in limits.ts and
 * takes no argument from here.
 */
function refreshMode(flags: Args["flags"], fallback: RefreshMode): RefreshMode {
  if (flags["no-refresh"] === true) return "off";
  if (flags.refresh === true) return "force";
  const env = process.env.CUSAGE_REFRESH;
  if (env === "off" || env === "stale" || env === "force") return env;
  return fallback;
}

const USAGE = `cusage — Claude subscription usage explorer

  sync [--limits-only] [--no-backfill]   ingest transcripts + snapshot limits (idempotent)
  session [<id>|--last]                  one chat: full token, attribution and cost breakdown
  sessions [--since 7d] [--by project|model|entrypoint|branch] [--limit N] [--project P]
  limits [--refresh]                     current server-reported limits, incl. weekly_scoped
  limits --history [--since 7d] [--bucket 1h] [--glaze]
  status                                 what the archive currently holds

  not yet implemented (phases 3-4):  cost  blocks  attribution  daily  weekly  monthly  export  pricing

Global flags
  --json         machine-readable output (never touches the formatter)
  --db <path>    override the archive location (default ${paths.db})
  --no-color     plain output

Refreshing limits
  weekly_scoped — "Fable 74%", the limit that actually binds — is in no local
  file, so \`limits\` and \`sync\` fetch it from /api/oauth/usage when the
  archived copy is older than 15m.

  --refresh      fetch now, skipping the staleness check
  --no-refresh   read the archive only; never touch the network
  \$CUSAGE_REFRESH=off|stale|force    the same choice, for launchd and scripts

  Every attempt, however triggered, sits behind a 3-minute floor that nothing
  overrides. No host other than api.anthropic.com is ever contacted.
`;

async function main(argv: string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  const json = flags.json === true || flags.json === "true";
  f.setColour(!json && flags["no-color"] !== true && Bun.stdout.writer !== undefined && process.stdout.isTTY === true);

  if (command === "help" || flags.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const db = openDb(str(flags.db) ?? paths.db);
  const emit = (data: unknown, text: () => string) => {
    process.stdout.write(json ? JSON.stringify(data, null, 2) + "\n" : text());
  };
  /** Operational asides go to stderr so `--json` stays parseable. */
  const note = (s: string | null) => {
    if (s) process.stderr.write(`${s}\n`);
  };

  try {
    switch (command) {
      case "sync": {
        const limitsOnly = flags["limits-only"] === true;
        const limits = await syncLimits(db, {
          backfill: flags["no-backfill"] !== true,
          refresh: refreshMode(flags, "stale"),
        });
        note(f.renderRefreshNote(limits.refresh));
        const ingest = limitsOnly ? null : ingestTranscripts(db, str(flags.transcripts) ?? paths.transcripts);
        const result = { db: str(flags.db) ?? paths.db, limitsOnly, limits, ingest };
        emit(result, () => {
          const lines = [`archive: ${result.db}`];
          if (ingest) {
            lines.push(
              `transcripts: ${ingest.filesRead}/${ingest.filesSeen} files read` +
                ` (${(ingest.bytesRead / 1e6).toFixed(1)} MB, ${ingest.linesParsed} lines)`,
              `records: ${ingest.assistantRecords} assistant, ${ingest.costStateRecords} cost-state,` +
                ` ${ingest.toolCalls} tool calls`,
            );
            if (ingest.parseErrors) lines.push(`parse errors: ${ingest.parseErrors}`);
            if (ingest.rewound) lines.push(`re-read from zero (truncated/rotated): ${ingest.rewound}`);
            if (ingest.partialTail) lines.push(`partial trailing record left for next run: ${ingest.partialTail}`);
          }
          lines.push(
            `limits: ${limits.refresh.ok ? "live fetch ok" : `no fetch (${limits.refresh.reason})`},` +
              ` ${limits.oauthInserted} oauth snapshot,` +
              ` ${limits.desktopInserted} desktop samples, ${limits.glazeInserted} glaze days,` +
              ` ${limits.scopedInserted} scoped rows`,
          );
          const st = q.archiveStats(db);
          lines.push(`archive now holds ${st.requests} requests across ${st.sessions} sessions`);
          return lines.join("\n") + "\n";
        });
        return 0;
      }

      case "session": {
        const ref = positional[0] ?? (flags.last === true ? "last" : null);
        const id = q.resolveSessionId(db, ref);
        if (!id) {
          process.stderr.write("no matching session\n");
          return 1;
        }
        const detail = q.getSession(db, id);
        if (!detail) {
          process.stderr.write("no matching session\n");
          return 1;
        }
        emit(detail, () => f.renderSession(detail));
        return 0;
      }

      case "sessions": {
        const since = parseSince(str(flags.since));
        const by = str(flags.by) as q.SessionsOptions["by"];
        if (by) {
          if (!["project", "model", "entrypoint", "branch"].includes(by)) {
            process.stderr.write(`--by must be project|model|entrypoint|branch\n`);
            return 2;
          }
          const rows = q.groupSessions(db, by, { since });
          emit(rows, () => f.renderGroups(rows, by) + "\n");
          return 0;
        }
        const rows = q.listSessions(db, {
          since,
          limit: Number(str(flags.limit) ?? 30),
          project: str(flags.project) ?? null,
        });
        emit(rows, () => f.renderSessions(rows) + "\n");
        return 0;
      }

      case "limits": {
        // Reading the limits is the one place a stale answer is actively
        // harmful, so this is the one read path allowed to go and check.
        const refresh = await refreshFromApi(db, { mode: refreshMode(flags, "stale") });
        note(f.renderRefreshNote(refresh));

        if (flags.history === true) {
          const bucket = str(flags.bucket);
          const bucketMs = parseDuration(bucket);
          if (bucket !== undefined && bucketMs === null) {
            process.stderr.write(`--bucket must look like 15m, 1h or 1d (got ${bucket})\n`);
            return 2;
          }
          const history = q.limitsHistory(db, {
            since: parseSince(str(flags.since) ?? "7d"),
            bucketMs,
            includeGlaze: flags.glaze === true,
          });
          emit(history, () => f.renderLimitsHistory(history));
          return 0;
        }

        const now = q.currentLimits(db);
        emit({ ...(now ?? {}), refresh }, () => f.renderLimits(now));
        return 0;
      }

      case "status": {
        const st = q.archiveStats(db);
        emit(st, () =>
          [
            `archive      ${str(flags.db) ?? paths.db}`,
            `requests     ${f.num(st.requests)}  across ${st.sessions} sessions` +
              ` (${st.sessionsWithCost} with cost-state)`,
            `tool calls   ${f.num(st.toolCalls)}`,
            `files        ${st.filesTracked} transcripts tracked`,
            `limits       ${f.num(st.limitSamples)} samples`,
            `covers       ${st.firstTs ?? "-"} → ${st.lastTs ?? "-"}`,
            `tokens       out ${f.num(st.totals.output_tokens)}` +
              `  cache w ${f.num(st.totals.cache_creation_tokens)}` +
              `  cache r ${f.num(st.totals.cache_read_tokens)}` +
              `  think ${f.num(st.totals.thinking_tokens)}`,
          ].join("\n") + "\n",
        );
        return 0;
      }

      case "cost":
      case "blocks":
      case "attribution":
      case "daily":
      case "weekly":
      case "monthly":
      case "export":
      case "pricing":
        process.stderr.write(`\`cusage ${command}\` is not implemented yet (phases 3-4).\n`);
        return 2;

      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    // Bad input reaches here as a thrown Error -- an unparseable `--since`, an
    // ambiguous session prefix. A stack trace for "you typed 7dd" is not a
    // diagnostic, it is noise, so the message is the output and the stack is
    // behind CUSAGE_DEBUG.
    if (process.env.CUSAGE_DEBUG) throw e;
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

export { main, parseArgs, VALUE_FLAGS };
