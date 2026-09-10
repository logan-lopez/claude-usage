/** Shared option vocabulary. Validation happens before opening the archive. */
import { Option, InvalidArgumentError, type Command } from "commander";
import { parseSince } from "./time.ts";

export const sinceOption = () =>
  new Option("--since <dur|iso|all>", "window start (inclusive)");
export const untilOption = () =>
  new Option("--until <dur|iso>", "window end (exclusive)");
export const projectOption = () =>
  new Option("--project <p>", "case-insensitive project substring");
export const modelOption = () =>
  new Option("--model <m>", "case-insensitive model substring");
export const byOption = (choices: string[]) =>
  new Option("--by <dim>", "grouping dimension").choices(choices);
export const limitOption = () =>
  new Option("--limit <n>", "maximum rows (positive integer)").argParser(
    (value) => {
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < 1
      )
        throw new InvalidArgumentError("--limit must be a positive integer");
      return value;
    },
  );
export function filters(command: Command): Command {
  return command
    .addOption(sinceOption())
    .addOption(untilOption())
    .addOption(projectOption())
    .addOption(modelOption())
    .addOption(limitOption());
}
export function readWindow(
  flags: Record<string, string | true>,
  defaultSince?: string,
) {
  const value = (key: string) =>
    typeof flags[key] === "string" ? (flags[key] as string) : undefined;
  const since = parseSince(value("since") ?? defaultSince);
  const end = value("until");
  if (end === "all")
    throw new Error("--until requires a duration or ISO date, not all");
  let until: number | null;
  try {
    until = parseSince(end);
  } catch {
    throw new Error(`unparseable --until value: ${end}`);
  }
  if (since !== null && until !== null && since >= until)
    throw new Error("--since must be before --until");
  return {
    since,
    until,
    project: value("project") ?? null,
    model: value("model") ?? null,
    limit: value("limit") ? Number(value("limit")) : undefined,
  };
}
