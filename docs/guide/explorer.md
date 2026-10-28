# The explorer

`cusage-tui` is a full-screen terminal browser for the archive: an Overview of limits and
activity, a searchable list of sessions, the sessions behind one day's output, and each session in
detail.

**Covers:** [TUI](../architecture/tui.md)

## Starting it

```bash
cusage-tui                       # the default archive
cusage-tui --db <path>           # or CUSAGE_DB
cusage-tui --no-color            # or NO_COLOR=1
cusage-tui --theme light         # or dark, auto; or CUSAGE_THEME
```

It needs an interactive terminal of at least 80×24. It never creates or upgrades an archive: with
no archive, it tells you to run `cusage sync`. Only `R` writes to it, to store the limits it
fetches.

## Screens

**1 Overview** has five panels:

- server limits, with source and age;
- archive health, from the same checks as `doctor` except the credential check;
- 72 hours of meter readings, one peak per hour, with gaps left as gaps;
- 30 days of output by UTC day, today partial, with a ▲ under the day you've chosen;
- the six most recent sessions.

At 110×36 and larger, all five show at once. In a smaller terminal you see one panel at a time
and switch with Tab.

In Daily output, ← and → (or `h` and `l`) move the ▲ from day to day, and the line under the bars
gives that day's output tokens. It starts on today, and stays on the day you chose when the
archive is reread, even across midnight. Enter lists that day's sessions.

**2 Sessions** is every session, 100 at a time, as you scroll.

- Search matches the session id or name.
- Filters narrow by project, model, and activity: all, today (UTC), the last 7 days or the last
  30 days.
- Sorting is by last activity, tokens or requests.

The amounts are always whole-session totals, even when an activity filter is on.

**A day's sessions** opens over Overview when you press Enter on a day in Daily output. The tab
bar shows it as `▸ Sessions · 2026-10-21 UTC`. It lists every session with at least one request
that UTC day, including ones that started earlier or went on after midnight, with whole-session
totals. It's the same list as Sessions, scoped to the day:

- Search, filters and sort work on top of the day, and clearing them keeps the day.
- It doesn't change the Sessions tab's own search or filters.
- Enter opens a session's Detail; Esc goes back to the list, then to Overview, with your place
  kept at each step.

**Session Detail** opens with Enter on a session in Sessions, in a day's sessions, or in
Overview's recent sessions. It
has a Summary and sections for models, attribution, tools and API blocks. The Summary gives
durations in hours and minutes and times in UTC, to the minute. Tool sections count calls; they
don't assign tokens to tools. Esc goes back to where you were, with the same selection and
filters.

The tab bar shows where you are: the two tabs, then whatever you opened over them, such as
`▸ Sessions · 2026-10-21 UTC › Session Detail`. Esc steps back one, and `1` or `2` goes straight
to that tab from anywhere.

## Keys

| Key | Action |
| --- | --- |
| `1`, `2` | Overview, Sessions, from anywhere |
| Tab, Shift+Tab | Next or previous panel, or Detail section |
| arrows, `j`/`k`, PageUp/PageDown, Home/End | Move or scroll |
| Enter | Open a session; in Daily output, list the chosen day's sessions |
| Esc | Go back one step, or cancel |
| `/`, `f`, `s` | Search, filters, sort (Sessions) |
| left, right | Choose a day in Daily output (or `h`/`l`); the attribution dimension in Detail; in other Detail sections, change section |
| `r` | Reread the archive and rerun the health checks |
| `R` | Fetch fresh limits |
| `?` | Help: keys, marks and the theme in use |
| `q`, Ctrl+C | Quit |

While you're typing in search or a filter, keys are text: `q` or `1` won't quit or switch screens.
Enter applies, Esc cancels, and Ctrl+C always quits.

`?` is help for the screen you're on: its own keys and what its marks mean, then the keys that
work everywhere. On Overview it's headed with the panel you're in. The footer shows only the keys
that do something where you are: Enter appears on Overview only in Daily output and Recent
sessions.

## Staying current

- The explorer notices new data in the archive within five seconds, from a background sync or
  the agents, and keeps your selection. The screen you're on rereads straight away; the others
  catch up when you next show them.
- `r` rereads the archive without fetching anything.
- `R` fetches live limits, subject to the same 3-minute spacing as the CLI. It's turned off by
  `CUSAGE_REFRESH=off`.
- If a read fails, the last good data stays on screen, marked outdated. If a fetch fails, the
  archived limits stay, with their ages.
- Messages in the status line, like "Limits refreshed." or "Refresh guarded; retry in 3m", clear
  after ten seconds. A warning that the archive couldn't be read stays until a read succeeds.

## Colours

At startup the explorer asks the terminal for its background colour and picks a light or dark
palette. Body text stays in your terminal's own foreground colour. If the terminal doesn't answer
(some multiplexers swallow the question), it assumes dark. With `--no-color` or `NO_COLOR` it
doesn't ask, and runs in monochrome. `--theme` or `CUSAGE_THEME` overrides
the choice, and `?` shows which theme was picked and why.
