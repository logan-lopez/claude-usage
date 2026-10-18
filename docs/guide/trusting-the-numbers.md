# Trusting the numbers

What cusage's figures can and can't tell you, and what it will never do. Read this before
quoting a number.

**Covers:** [Limits](../architecture/limits.md), [Cost](../architecture/cost.md), [Ingest](../architecture/ingest.md), [CLI](../architecture/cli.md)

## What it will never do

- **Read what you wrote.** cusage keeps tool names and token counts only:
  - no message text, prompts, tool inputs or tool results;
  - none of the account identifiers in `~/.claude.json`.

  Your credentials are read to sign one request and are never stored or shown.
- **Present a guess as a measurement.** Server limits and local attribution are reported
  separately, and measured cost is never mixed with estimates.
- **Present an old number as current.** Every limit shows where it came from and how old it is.

## What the data can't tell you

- **Local data covers Claude Code only.** claude.ai and the desktop app's chats count towards your
  limits but leave nothing on disk.
  - In 39% of the sampled moments when the five-hour meter was at 15% or more, there had been no
    Claude Code activity in the previous five hours.
  - Your Claude Code tokens loosely track the five-hour meter (r=0.69). They don't explain the
    seven-day meter at all (r=0.04).
- **Cost is API-equivalent,** not what your subscription charges. Measured cost exists only for
  sessions where Claude Code wrote a cost record; the rest are estimates, marked `~$` in the explorer
  and `estimated` in `cusage cost`.
- **Grouped cost leaves out sessions that span groups.** A `+` means some cost was left out, not
  that it was zero ([Cost](cost.md)).
- **Web search and fetch counters read zero** even when those tools ran. They run on your side,
  not as server tools, so the server never counts them.
- **The five-minute and one-hour cache writes don't add up** to the total cache writes. The gap is
  small (about 1K tokens in 42M) and `cusage cache` shows it.
- **Cache reads drop after a compaction.** Don't read them as a steady measure of context size.
- **The Glaze figure is inferred.** Its daily number carries no label. It matches the five-hour
  meter, so cusage stores it as that, shows it, and never uses it for the current reading.
- **A request isn't a message.** One reply in the chat can be several API requests.
