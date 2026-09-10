#!/usr/bin/env bun
/**
 * Argument parsing and dispatch. Nothing else.
 *
 * This file must never import ./tui.ts, ink or react — not even lazily, for
 * now. The archiver runs hourly under launchd and the statusline may poll
 * `--json` several times a minute; neither may pay React's startup cost.
 * `cusage tui` is a separate bin target. See CLAUDE.md.
 */
import { Database } from "bun:sqlite";
import { openDb } from "./schema.ts";
import { ingestTranscripts } from "./ingest.ts";
import { type RefreshMode, refreshFromApi, syncLimits } from "./limits.ts";
import { paths } from "./paths.ts";
import { parseDuration, parseSince } from "./time.ts";
import * as q from "./query.ts";

import { Command, CommanderError, Option } from "commander";
import { filters, byOption, readWindow } from "./args.ts";
import { reportCsv, serializeRows } from "./serialize.ts";

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
}

export function createProgram(): Command {
  const program = new Command()
    .name("cusage")
    .description("Claude subscription usage explorer")
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .configureHelp({ showGlobalOptions: true })
    .option("--db <path>", "archive override")
    .addOption(new Option("--json", "machine-readable output").conflicts("csv"))
    .addOption(new Option("--csv", "CSV output").conflicts("json"))
    .option("--no-color", "plain output")
    .option(
      "--refresh",
      "refresh stale limits (3-minute attempt floor still applies)",
    )
    .option("--no-refresh", "archive only");
  program
    .command("sync")
    .description("ingest transcripts and snapshot limits")
    .option("--limits-only")
    .option("--no-backfill")
    .option("--transcripts <path>");
  program
    .command("session [id]")
    .description("one chat's token and cost breakdown")
    .option("--last");
  filters(
    program.command("sessions").description("list or group chats"),
  ).addOption(byOption(["project", "model", "entrypoint", "branch"]));
  program
    .command("limits")
    .description("server-reported limits")
    .option("--history")
    .option("--until <dur|iso>")
    .option("--since <dur|iso|all>")
    .option("--bucket <duration>")
    .option("--glaze");
  program.command("status").description("archive inventory");
  filters(
    program
      .command("attribution")
      .description("local attribution with coverage"),
  ).addOption(
    byOption([...Object.keys(q.ATTRIBUTION_COLUMNS), "tool"]).default("agent"),
  );
  for (const name of ["timeline", "daily", "weekly", "monthly"]) {
    const cmd = filters(
      program.command(name).description("UTC token time series"),
    ).addOption(byOption(["model", "project", "effort"]));
    if (name === "timeline")
      cmd.addOption(
        new Option("--bucket <size>")
          .choices(["day", "week", "month", "auto"])
          .default("day"),
      );
  }
  filters(program.command("export").description("stream archived rows"))
    .addOption(
      new Option("--format <format>")
        .choices(["json", "ndjson", "csv"])
        .default("ndjson"),
    )
    .addOption(
      new Option("--table <table>")
        .choices(["requests", "sessions", "tools", "limits"])
        .default("requests"),
    );
  filters(
    program
      .command("cost")
      .description("measured costs and separate token estimates"),
  )
    .addOption(byOption(["model", "project", "session", "day"]))
    .addOption(new Option("--measured").conflicts("estimated"))
    .addOption(new Option("--estimated").conflicts("measured"));
  filters(
    program
      .command("cache")
      .description("cache read/creation ratio and reconciliation gap"),
  ).addOption(byOption(["model", "project"]));
  filters(
    program
      .command("blocks")
      .description("observed five-hour meter cycles with local context"),
  );
  program
    .command("statusline")
    .description("one archived line; refreshes in background");
  program
    .command("doctor")
    .description("check archive and launch agents")
    .option("--repo <path>", "repository HEAD to compare with binary stamp");
  return program;
}

/** Commander validates first; this adapter preserves the dispatch boundary. */
function parseArgs(argv: string[], program = createProgram()): Args {
  let result: Args = { command: "help", positional: [], flags: {} };
  for (const cmd of program.commands)
    cmd.action((...args: unknown[]) => {
      const command = args.at(-1) as Command;
      const flags: Args["flags"] = {};
      for (const [key, value] of Object.entries(command.optsWithGlobals())) {
        const owner = command.getOptionValueSource(key) ? command : program;
        if (owner.getOptionValueSource(key) === "default") continue;
        const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        if (value === false) flags[`no-${name}`] = true;
        else flags[name] = value === true ? true : String(value);
      }
      result = { command: command.name(), positional: command.args, flags };
    });
  if (argv.length) program.parse(argv, { from: "user" });
  return result;
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

async function main(argv: string[]): Promise<number> {
  const program = createProgram();
  let parsed: Args;
  try {
    parsed = parseArgs(argv, program);
  } catch (e) {
    if (e instanceof CommanderError && e.exitCode === 0) return 0;
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const { command, positional, flags } = parsed;
  let window: ReturnType<typeof readWindow>;
  try {
    window = readWindow(flags);
    if (
      command === "export" &&
      flags.format &&
      ((flags.json && flags.format !== "json") ||
        (flags.csv && flags.format !== "csv"))
    )
      throw new Error(
        "--format conflicts with the selected --json/--csv output",
      );
    if (
      command === "limits" &&
      flags.bucket !== undefined &&
      !(parseDuration(str(flags.bucket))! > 0)
    )
      throw new Error(
        "--bucket must be a positive duration such as 15m, 1h or 1d",
      );
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const json = flags.json === true || flags.json === "true";
  const csv = flags.csv === true;
  const f =
    !json && !csv && command !== "export" ? await import("./format.ts") : null!;
  if (f)
    f.setColour(
      !csv &&
        !json &&
        flags["no-color"] !== true &&
        Bun.stdout.writer !== undefined &&
        process.stdout.isTTY === true,
    );

  if (command === "help" || flags.help === true) {
    program.outputHelp();
    return 0;
  }

  let db: Database;
  try {
    db =
      command === "doctor"
        ? new Database(str(flags.db) ?? paths.db, { readonly: true })
        : openDb(str(flags.db) ?? paths.db);
  } catch (e) {
    process.stderr.write(`cannot open archive: ${(e as Error).message}\n`);
    return 2;
  }
  const emit = (data: unknown, text: () => string) => {
    process.stdout.write(
      json
        ? JSON.stringify(data, null, 2) + "\n"
        : csv
          ? reportCsv(data)
          : text(),
    );
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
        note(
          limits.refresh.reason === "failed"
            ? `could not refresh: ${limits.refresh.error}. Showing archived data.`
            : (f?.renderRefreshNote(limits.refresh) ?? null),
        );
        const ingest = limitsOnly
          ? null
          : ingestTranscripts(db, str(flags.transcripts) ?? paths.transcripts);
        const result = {
          db: str(flags.db) ?? paths.db,
          limitsOnly,
          limits,
          ingest,
        };
        emit(result, () => {
          const lines = [`archive: ${result.db}`];
          if (ingest) {
            lines.push(
              `transcripts: ${ingest.filesRead}/${ingest.filesSeen} files read` +
                ` (${(ingest.bytesRead / 1e6).toFixed(1)} MB, ${ingest.linesParsed} lines)`,
              `records: ${ingest.assistantRecords} assistant, ${ingest.costStateRecords} cost-state,` +
                ` ${ingest.toolCalls} tool calls`,
            );
            if (ingest.parseErrors)
              lines.push(`parse errors: ${ingest.parseErrors}`);
            if (ingest.rewound)
              lines.push(
                `re-read from zero (truncated/rotated): ${ingest.rewound}`,
              );
            if (ingest.partialTail)
              lines.push(
                `partial trailing record left for next run: ${ingest.partialTail}`,
              );
          }
          lines.push(
            `limits: ${limits.refresh.ok ? "live fetch ok" : `no fetch (${limits.refresh.reason})`},` +
              ` ${limits.oauthInserted} oauth snapshot,` +
              ` ${limits.desktopInserted} desktop samples, ${limits.glazeInserted} glaze days,` +
              ` ${limits.scopedInserted} scoped rows`,
          );
          const st = q.archiveStats(db);
          lines.push(
            `archive now holds ${st.requests} requests across ${st.sessions} sessions`,
          );
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
        const by = str(flags.by) as q.SessionsOptions["by"];
        if (by) {
          if (!["project", "model", "entrypoint", "branch"].includes(by)) {
            process.stderr.write(
              `--by must be project|model|entrypoint|branch\n`,
            );
            return 2;
          }
          const data = q.sessionGroupsReport(db, by, window);
          emit(
            data,
            () =>
              f.renderGroups(data.rows, by, data.coverage) +
              `\n${data.rows.length} of ${data.groups} groups shown · ${data.source}\n`,
          );
          return 0;
        }
        const rows = q.listSessions(db, {
          ...window,
          limit: window.limit ?? 30,
        });
        emit(rows, () => f.renderSessions(rows) + "\n");
        return 0;
      }

      case "limits": {
        // Reading the limits is the one place a stale answer is actively
        // harmful, so this is the one read path allowed to go and check.
        const refresh = await refreshFromApi(db, {
          mode: refreshMode(flags, "stale"),
        });
        note(
          refresh.reason === "failed"
            ? `could not refresh: ${refresh.error}. Showing archived data.`
            : (f?.renderRefreshNote(refresh) ?? null),
        );

        if (flags.history === true) {
          const bucket = str(flags.bucket);
          const bucketMs = parseDuration(bucket);
          if (bucket !== undefined && bucketMs === null) {
            process.stderr.write(
              `--bucket must look like 15m, 1h or 1d (got ${bucket})\n`,
            );
            return 2;
          }
          const history = q.limitsHistory(db, {
            since: parseSince(str(flags.since) ?? "7d"),
            bucketMs,
            until: window.until,
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
        emit(
          st,
          () =>
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

      case "attribution": {
        const data = q.attribution(
          db,
          (str(flags.by) ?? "agent") as q.AttributionDimension,
          window,
        );
        emit(data, () => f.renderAttribution(data));
        return 0;
      }
      case "timeline":
      case "daily":
      case "weekly":
      case "monthly": {
        const bucket =
          ({ daily: "day", weekly: "week", monthly: "month" } as const)[
            command as "daily" | "weekly" | "monthly"
          ] ??
          str(flags.bucket) ??
          "day";
        const data = q.timeline(db, {
          ...readWindow(flags, "30d"),
          bucket: bucket as q.TimelineBucket,
          by: str(flags.by) as "model" | "project" | "effort" | undefined,
        });
        emit(data, () => f.renderTimeline(data));
        return 0;
      }
      case "blocks": {
        const data = q.blocks(db, readWindow(flags, "7d"));
        emit(data, () => f.renderBlocks(data));
        return 0;
      }
      case "statusline": {
        const data = q.statusline(db);
        const { scheduleStatusRefresh } = await import("./statusline.ts");
        const refreshScheduled = scheduleStatusRefresh(
          db,
          str(flags.db) ?? paths.db,
          refreshMode(flags, "stale"),
        );
        emit({ ...data, refreshScheduled }, () => f.renderStatusline(data));
        return 0;
      }
      case "cost": {
        const data = q.cost(db, {
          ...readWindow(flags, "30d"),
          by: str(flags.by) as
            | "model"
            | "project"
            | "session"
            | "day"
            | undefined,
          basis: flags.measured
            ? "measured"
            : flags.estimated
              ? "estimated"
              : undefined,
        });
        emit(data, () => f.renderCost(data));
        return 0;
      }
      case "cache": {
        const data = q.cache(db, {
          ...readWindow(flags, "30d"),
          by: str(flags.by) as "model" | "project" | undefined,
        });
        emit(data, () => f.renderCache(data));
        return 0;
      }
      case "doctor": {
        const { doctor } = await import("./doctor.ts");
        const data = await doctor(db, str(flags.db) ?? paths.db, {
          repo: str(flags.repo),
        });
        emit(data, () => f.renderDoctor(data));
        return data.exitCode;
      }
      case "export": {
        const format = (str(flags.format) ??
          (json ? "json" : csv ? "csv" : "ndjson")) as
          | "json"
          | "ndjson"
          | "csv";
        const data = q.exportRows(
          db,
          (str(flags.table) ?? "requests") as q.ExportTable,
          window,
        );
        for (const chunk of serializeRows(data.rows, format, data.columns)) {
          if (!process.stdout.write(chunk))
            await new Promise<void>((resolve) =>
              process.stdout.once("drain", resolve),
            );
        }
        return 0;
      }

      default:
        process.stderr.write(`unknown command: ${command}`);
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

export { main, parseArgs };
