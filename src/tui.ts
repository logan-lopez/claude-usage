#!/usr/bin/env bun
/** Separate executable boundary. React/Ink imports belong only here or in src/tui/. */
import { parseArgs } from "node:util";
import { paths } from "./paths.ts";

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        db: { type: "string" },
        help: { type: "boolean", short: "h" },
        "no-color": { type: "boolean" },
      },
    }));
  } catch (error) {
    process.stderr.write(
      `cusage-tui: ${error instanceof Error ? error.message : "Invalid arguments"}\nUse cusage-tui --help.\n`,
    );
    return 2;
  }
  if (values.help) {
    process.stdout.write(
      "Usage: cusage-tui [--db PATH] [--no-color]\n\nBrowse Overview, Sessions and Session Detail. Requires an 80×24 TTY.\nCUSAGE_DB overrides the archive path. Browsing is read-only.\nr rereads the archive; R explicitly fetches limits (CUSAGE_REFRESH=off disables).\nRun cusage sync to create or update the archive.\n",
    );
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "cusage-tui requires an interactive terminal. Use cusage sessions, cusage session, or cusage limits.\n",
    );
    return 2;
  }
  const mono =
    values["no-color"] === true || process.env.NO_COLOR !== undefined;
  if (mono) {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
  }
  const { openArchive, archiveDependencies } = await import("./tui/data.ts");
  const file = values.db ?? paths.db;
  let db;
  try {
    db = openArchive(file);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Archive unreadable"}\n`,
    );
    return 2;
  }
  let instance: import("ink").Instance | undefined;
  try {
    const [{ createElement }, { render }, { App }] = await Promise.all([
      import("react"),
      import("ink"),
      import("./tui/App.tsx"),
    ]);
    instance = render(
      createElement(App, { deps: archiveDependencies(db, file), mono }),
      { alternateScreen: true, exitOnCtrlC: false, patchConsole: false },
    );
    await instance.waitUntilExit();
    return 0;
  } catch (error) {
    process.stderr.write(
      `cusage-tui: ${error instanceof Error ? error.message : "Fatal rendering error"}\n`,
    );
    return 2;
  } finally {
    instance?.unmount();
    instance?.cleanup();
    db.close();
  }
}
process.exitCode = await main();
