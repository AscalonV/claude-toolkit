# account-statusline

A Claude Code status line that shows who is signed in and how much usage is left, plus a usage guard that warns Claude before a limit is hit:

```
Alex | high | ctx 95k | 5h 42% (resets 15:30) | week 18% (resets Fri 09:00)
```

- **Account**: the display name of the logged-in claude.ai account (falls back to its email), read from that PC's own `~/.claude.json`, so each machine shows whoever is logged in there.
- **Effort**: the current reasoning effort level.
- **ctx**: tokens in the context window.
- **5h / week**: subscription usage windows and when they reset, in local time.

It shows at launch, before the first message, and needs no Python or other runtime.

## How it works

Claude Code doesn't let plugins draw in the status line row, so on its first start the plugin adds a `statusLine` command to `~/.claude/settings.json`. It only does that when no status line is set; one of your own is left alone. The plugin keeps each running session's line in `~/.claude/account-statusline.tsv`, and the command prints the row for its session. Rows of sessions idle for 12 hours are dropped.

The first time, restart Claude Code once after installing so it picks up the new `statusLine` setting. With `CLAUDE_CONFIG_DIR` set, that folder is used instead of `~/.claude`.

After `/login` to another account, usage numbers are hidden until the new account's first fresh reading, so the old account's numbers never show or trigger the guard.

## Usage guard

The guard watches the same 5-hour and weekly numbers. Each limit has two stages:

| Limit | Wrap-up | Stop |
| --- | --- | --- |
| 5-hour | 75 % | 90 % |
| Weekly | 90 % | 97 % |

When a stage is reached, the plugin adds a note to Claude's next request (context for Claude, not a popup). Each stage is sent once per limit window, session and agent.

- **Wrap-up:** finish the current step, fill in the handoff file, tell running agents to update their notes, then go on without starting large new work.
- **Stop:** start no new work, tell agents to stop, leave the repo buildable and write final notes, fold the notes into the handoff file, then tell you in one line that the handoff is ready.
- **Subagents** get their own shorter note in their own conversation.
- **After compaction**, Claude is told to read this session's handoff file, or the newest one in the handoff folder.

### Handoff file

At the first warning in a session, the plugin creates `<project>/handoffs/<YYYY-MM-DD>-<HHMM>-<session id, 8 chars>.md` (the project is the git top level, else the working directory). It never overwrites an existing file. It fills in what it knows and leaves the rest for Claude:

```markdown
# Handoff 2026-10-22 14:05

- Account: Alex
- Session: `abcdef12-...`
- Working directory: `/home/alex/project`
- Git branch: `main`
- Uncommitted files:
  - ` M src/app.ts`
- Usage 5-hour: 76% (resets 10/22 15:40)
- Usage weekly: 41% (resets 10/24 09:00)

## Running agents

- build docs (general-purpose, running, id `a1b2`)

## Goal

## Done

## Next steps

## Agents and their notes files

## Open questions
```

### Settings

| Option | Default | What it does |
| --- | --- | --- |
| `guard` | `true` | Turns the guard on or off |
| `agentNotes` | `true` | Sends subagents their own notes |
| `handoffFile` | `true` | Creates the handoff file |
| `handoffFolder` | `handoffs` | Handoff folder, relative to the project root, or absolute |
| `fiveHourWrapUp` / `fiveHourStop` | `75` / `90` | 5-hour thresholds in % |
| `weeklyWrapUp` / `weeklyStop` | `90` / `97` | Weekly thresholds in % |
| `extraNote` | empty | Text appended to every guard note |

Set them when installing (`--config key=value`, repeatable), later in `/plugin` (the plugin's configure screen), or from a shell:

```
echo '{"fiveHourWrapUp":"70","handoffFolder":"docs/handoffs"}' | claude plugin configure account-statusline@ascalonv --values-stdin
```

A value that isn't valid (not a number from 1 to 100, wrap-up not below stop, an empty folder) falls back to its default, and the session shows a one-line notice.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install account-statusline --marketplace AscalonV/account-statusline
```

Answer `y` to add the marketplace, then pick the user scope. No GitHub account or login is needed.

From a shell:

```
claude plugin install account-statusline --marketplace AscalonV/account-statusline
```

With settings, for example:

```
claude plugin install account-statusline --marketplace AscalonV/account-statusline --config fiveHourWrapUp=70 --config handoffFolder=docs/handoffs
```

## Uninstall

Remove the plugin with `/plugin`, then delete the `statusLine` entry from `~/.claude/settings.json` and the file `~/.claude/account-statusline.tsv`.

## Tests

```
claude plugin test .
```
