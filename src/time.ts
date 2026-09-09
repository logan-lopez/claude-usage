/** `7d`, `36h`, `90m`, `2w` as a length of time. Null when it is not one. */
export function parseDuration(input: string | undefined | null): number | null {
  if (!input) return null;
  const m = /^(\d+)\s*([mhdw])$/.exec(input.trim());
  if (!m) return null;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]!]!;
  return Number(m[1]) * unit;
}

/** `7d`, `36h`, `90m`, `2w`, or an ISO date. Returns epoch ms, or null for "all time". */
export function parseSince(input: string | undefined | null): number | null {
  if (!input || input === "all") return null;
  const rel = parseDuration(input);
  if (rel !== null) return Date.now() - rel;
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) throw new Error(`unparseable --since value: ${input}`);
  return parsed;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * How old a reading is, in the shortest honest form. Distinct from
 * fmtDuration because the answer to "how stale is this?" is a different
 * question from "how long did this take?", and because `-` for a missing age
 * would read as "no age", i.e. fresh.
 */
export function fmtAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "unknown age";
  if (ms < 0) return "in the future";
  const s = Math.round(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Epoch ms in the same shape fmtWhen gives an ISO string. */
export function fmtWhenMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "-" : fmtWhen(new Date(ms).toISOString());
}

export function fmtWhen(ts: string | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace("T", " ").slice(0, 16);
}
