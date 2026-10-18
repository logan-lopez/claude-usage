# Sessions

Every Claude Code chat is a session. cusage can show one in full, list them, group them, and say
which agents, skills, MCP servers and tools the tokens went to.

**Covers:** [CLI](../architecture/cli.md), [Ingest](../architecture/ingest.md), [Cost](../architecture/cost.md)

## One session

`cusage session --last` shows the most recently active chat; `cusage session <id>` shows a
particular one, by full id, a unique prefix or its slug. You get:

- the project, branch and entry point;
- the time span, with wall time, API time and tool time;
- the number of API blocks. That's a per-session counter, not the server's five-hour window;
- tokens: requests, input, output, thinking, cache writes, cache reads and total;
- a breakdown by model, effort, agent, skill, MCP server and plugin, each with how many requests
  it accounts for;
- tool call counts;
- cost per model, and whether that cost is measured or estimated.

A request is one API call. One reply you see in the chat can be several requests, so the request
count is higher than the message count.

If nothing matches, `session` exits with code 1. A prefix that matches more than one session is
an error, code 2.

## Listing and grouping

`cusage sessions` lists the 30 most recent chats (`--limit` for more) with their requests, output, cache reads, total tokens and
cost. The totals are always for the whole session, even when `--since` picks sessions by their
last activity.

`cusage sessions --by project|model|entrypoint|branch` groups them instead. Grouping works on
individual requests, so a session that touched two projects counts in both. Its cost, though, is
left out of both groups and the column is marked `+`. [Cost](cost.md) explains why.

Every grouped report says how many requests it covers, even when `--limit` hides some of the
groups.

## Attribution

`cusage attribution --by <dim>` says where requests went, by `agent` (the default), `skill`,
`plugin`, `mcp`, `effort`, `entrypoint`, `branch`, `version`, `model` or `tool`. Each report opens
with a coverage line: how many requests had that attribution, and how many didn't.

`--by tool` also counts **calls**. One request can call several tools, so it appears under each of
them, and the token columns there are context: don't add them up as each tool's consumption.

## Filters

`sessions`, `attribution` and the other request reports share the same filters:

- `--since <duration|date|all>` and `--until <duration|date>`, for example `--since 7d`;
- `--project <text>` and `--model <text>`, which match case-insensitively on any part of the
  name;
- `--limit <n>`, which caps the rows shown without changing the totals.

See [Scripting](scripting.md) for the exact rules.
