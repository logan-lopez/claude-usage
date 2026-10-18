# Scripting

Every report can come out as JSON or CSV instead of a table, and `export` streams raw archive rows.

**Covers:** [CLI](../architecture/cli.md)

## Output formats

- `--json` gives the report's data as JSON, with no colour codes.
- `--csv` gives one row per data row:
  - commas, quotes and newlines are quoted;
  - the report's metadata, including coverage, repeats on every row.
- `--no-color` keeps the table but drops the colour. Colour is also off whenever the output isn't
  a terminal.

These flags, and `--db`, `--refresh` and `--no-refresh`, work before or after the command name:
`cusage --json limits` and `cusage limits --json` are the same.

Grouped reports in JSON, such as `sessions --by project --json`, return
`{ rows, coverage, … }`, not a bare list.

## Filters

| Flag | Meaning |
| --- | --- |
| `--since <duration\|date\|all>` | Start of the window, inclusive. A duration in `m`, `h`, `d` or `w` (`30d`, `12h`, `2w`), an ISO date, or `all` |
| `--until <duration\|date>` | End of the window, exclusive |
| `--project <text>`, `--model <text>` | Case-insensitive substring match. `%` is a literal character, not a wildcard |
| `--limit <n>` | A positive whole number; caps rows without changing totals or coverage |

Session lists and session exports pick whole sessions by their last activity, so their totals are
lifetime totals. Grouped reports filter individual requests.

## Export

```bash
cusage export                                 # every request, as NDJSON
cusage export --table sessions --format csv
cusage export --table limits --since 30d --json
```

- `--table` is `requests` (the default), `sessions`, `tools` or `limits`.
- `--format` is `ndjson` (the default), `json` or `csv`. `--json` and `--csv` are shortcuts, and
  conflicting choices are an error.
- All three formats stream, so a large export starts at once and doesn't fill memory.
- Limit samples can't be filtered by project or model.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | `session` found no match; `doctor` found warnings |
| 2 | A usage error: an unknown option, an invalid `--by` value, an unparseable date, an ambiguous session prefix. `doctor` also uses 2 for broken |

`cusage --help` and `cusage <command> --help` list every option.
