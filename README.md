# toolkit

A Claude Code plugin with three parts:

- a **status line** that shows who is signed in and how much usage is left,
- a **usage guard** that warns Claude before a limit is hit and starts a handoff file,
- **effort skills** so Claude picks its thinking effort per turn.

## Status line


```
Alex | high | ctx 95k | 5h 42% (resets 15:30) | week 18% (resets Fri 09:00)
```

- **Account**: the display name of the logged-in claude.ai account (falls back to its email), read from that PC's own `~/.claude.json`, so each machine shows whoever is logged in there.
- **Effort**: the current reasoning effort level.
- **ctx**: tokens in the context window.
- **5h / week**: subscription usage windows and when they reset, in local time.

It shows at launch, before the first message, and needs no Python or other runtime.

### How it works

Claude Code doesn't let plugins draw in the status line row, so on its first start the plugin adds a `statusLine` command to `~/.claude/settings.json`. It only does that when no status line is set; one of your own is left alone. The plugin keeps each running session's line in `~/.claude/toolkit.tsv`, and the command prints the row for its session. Rows of sessions idle for 12 hours are dropped.

The first time, restart Claude Code once after installing so it picks up the new `statusLine` setting. With `CLAUDE_CONFIG_DIR` set, that folder is used instead of `~/.claude`.

After `/login` to another account, usage numbers are hidden until the new account's first fresh reading, so the old account's numbers never show or trigger the guard.

## Usage guard

The guard watches the same 5-hour and weekly numbers. Each limit has two stages:

| Limit | Wrap-up | Stop |
| --- | --- | --- |
| 5-hour | 85 % | 90 % |
| Weekly | 90 % | 97 % |

When a stage is reached, the plugin adds a note to Claude's next request (context for Claude, not a popup). Each stage is sent once per limit window, session and agent.

- **Wrap-up:** finish the current step, fill in the handoff file, tell running agents to update their notes, then go on without starting large new work.
- **Stop:** start no new work, tell agents to stop, leave the repo buildable and write final notes, fold the notes into the handoff file, then tell you in one line that the handoff is ready.
- **Subagents** get their own shorter note in their own conversation.
- **After compaction**, Claude is told to read this session's handoff file, or the newest one in the handoff folder.

### Handoff file

At the first warning in a session, the plugin creates `<YYYY-MM-DD>-<HHMM>-<session id, 8 chars>.md`. Where it goes depends on whether the session runs in a project:

- **In a project:** `<project>/handoffs/`. The project is the git top level, or else the nearest folder up from the working directory that has a `CLAUDE.md` or `.claude/` folder. Your home folder doesn't count, even though it holds `~/.claude`.
- **Outside a project** (a broad task, for example started in your home folder): `~/.claude/handoffs/`, or `CLAUDE_CONFIG_DIR/handoffs/`.

It never overwrites an existing file. It fills in what it knows and leaves the rest for Claude:

```markdown
# Handoff 2026-10-22 14:05

- Account: Alex
- Session: `abcdef12-...`
- Project: `/home/alex/project`
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
| `effortRules` | `true` | Adds the effort rules to Claude's instructions |
| `guard` | `true` | Turns the guard on or off |
| `agentNotes` | `true` | Sends subagents their own notes |
| `handoffFile` | `true` | Creates the handoff file |
| `handoffFolder` | `handoffs` | Handoff folder in a project, relative to the project root, or absolute |
| `outsideProjectFolder` | `handoffs` | Handoff folder outside a project, relative to the Claude config folder, or absolute |
| `fiveHourWrapUp` / `fiveHourStop` | `85` / `90` | 5-hour thresholds in % |
| `weeklyWrapUp` / `weeklyStop` | `90` / `97` | Weekly thresholds in % |
| `extraNote` | empty | Text appended to every guard note |

Set them when installing (`--config key=value`, repeatable), later in `/plugin` (the plugin's configure screen), or from a shell:

```
echo '{"fiveHourWrapUp":"70","handoffFolder":"docs/handoffs"}' | claude plugin configure toolkit@ascalonv --values-stdin
```

A value that isn't valid (not a number from 1 to 100, wrap-up not below stop, an empty folder) falls back to its default, and the session shows a one-line notice.

## Effort skills

The plugin ships four skills, `toolkit:effort-low`, `-medium`, `-high` and `-xhigh`. Each one sets Claude's thinking effort for the rest of the turn. The plugin also adds these rules to Claude's instructions:

- The default is your session's effort setting (`high` if none is set). For a turn with tool work, Claude picks a level from the skill descriptions and, if it differs from the default, invokes that skill in the same message as its first tool call. A turn without tool calls doesn't switch.
- Claude names the level in one line of every reply, e.g. `Effort: low (bookkeeping)`. You override it with `/effort`.
- When unsure, Claude keeps the default. `max` only when you ask for it.
- Subagents for searching or exploring run at `effort: low`.

| Level | Fits |
| --- | --- |
| low | bookkeeping, notes, lookups, reading or listing files, running a known command |
| medium | changes of a known shape: config edits, renames, version bumps, docs, a fix whose cause is clear |
| high | new features, bugs with an unknown cause, multi-file changes, reviewing test feedback |
| xhigh | architecture or design decisions, tricky performance or concurrency work, a second try after a failed fix |

Turn the rules off with the `effortRules` setting; the skills stay available either way.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install toolkit --marketplace AscalonV/claude-toolkit
```

Answer `y` to add the marketplace, then pick the user scope. No GitHub account or login is needed.

From a shell:

```
claude plugin install toolkit --marketplace AscalonV/claude-toolkit
```

With settings, for example:

```
claude plugin install toolkit --marketplace AscalonV/claude-toolkit --config fiveHourWrapUp=70 --config handoffFolder=docs/handoffs
```

### Upgrading from account-statusline

This plugin used to be called `account-statusline`. Remove that one with `/plugin`, then install `toolkit` as above. The status line setting is updated on the first start; guard settings you changed need to be set again.

## Uninstall

Remove the plugin with `/plugin`, then delete the `statusLine` entry from `~/.claude/settings.json` and the file `~/.claude/toolkit.tsv`.

## Tests

```
claude plugin test .
```
