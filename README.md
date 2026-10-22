# toolkit

A Claude Code plugin with four parts:

- a **status line** that shows who is signed in and how much usage is left,
- a **usage guard** that warns Claude before a limit is hit and starts a handoff file,
- **effort skills** so Claude picks its thinking effort per turn,
- **agents**: a project's own rules for its subagents, and an optional rule to start agents without being asked,
- a **context budget** that Claude sets per task, so the conversation is compacted early on simple tasks and late on complex ones.

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

When a stage is reached, the plugin adds a note to Claude's next request (context for Claude, not a popup). Each stage is sent once per limit window, session and agent, also across a plugin reload or update. The main chat gets its notes once it has started a turn, so a session opened and closed without a message gets no note and leaves no handoff file.

- **Wrap-up:** finish the current step, fill in the handoff file, tell running agents to update their notes, then go on without starting large new work.
- **Stop:** start no new work, tell agents to stop, leave the repo buildable and write final notes, fold the notes into the handoff file, then tell you in one line that the handoff is ready.
- **Subagents** get their own shorter note in their own conversation.
- **After compaction** (the context budget's, `/compact` or Claude Code's own; not a summary Claude Code only prepares in advance), Claude is told to read this session's handoff file: the task's own file when Claude named one, else the session's draft. It never points to another session's file, which belongs to another task; with neither, Claude goes on from the compaction summary.

### Handoff file

**The task's own file wins.** When a task already has a handoff (written the project's way, or the one a new chat continues from), Claude names it with `ContextBudget` (`handoff: "<path>"`), and the guard notes and the compaction point to it instead of a draft.

Otherwise, at the first warning in a session (once the main chat has started a turn), the plugin creates a draft `<YYYY-MM-DD>-<HHMM>-<session id, 8 chars>.md`. Where it goes depends on whether the session runs in a project:

- **In a project:** `<project>/handoffs/`. The project is the git top level, or else the nearest folder up from the working directory that has a `CLAUDE.md` or `.claude/` folder. Your home folder doesn't count, even though it holds `~/.claude`.
- **Outside a project** (a broad task, for example started in your home folder): `~/.claude/handoffs/`, or `CLAUDE_CONFIG_DIR/handoffs/`.

If the session already has one (from before a restart or plugin reload), the guard keeps using that file instead of starting a new one. It never overwrites an existing file. It fills in what it knows and leaves the rest for Claude. The draft says `Status: draft` until Claude fills it in and sets it to `open`, so a task finder that looks for `Status: open` never picks up an empty draft; the guard note also tells Claude to delete the draft when the task has its own file. Account, usage and agents are a snapshot from when it was created:

```markdown
# Handoff 2026-10-22 14:05
Updated: 2026-10-22 14:05 · Status: draft (set to open once filled in)

Created by the usage guard; the lines below are a snapshot from that moment.

- Account: Alex
- Session: `abcdef12-...`
- Project: `/home/alex/project`
- Working directory: `/home/alex/project`
- Git branch: `main`
- Uncommitted files:
  - ` M src/app.ts`
- Usage 5-hour: 76% (resets 10/22 15:40)
- Usage weekly: 41% (resets 10/24 09:00)

## Running agents (when created)

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
| `agentRules` | `true` | Adds the project's `.claude/agent-rules.md` to every new subagent's prompt |
| `agentUse` | `false` | Tells Claude to start subagents on its own when parallel work makes sense |
| `handoffFolder` | `handoffs` | Handoff folder in a project, relative to the project root, or absolute |
| `outsideProjectFolder` | `handoffs` | Handoff folder outside a project, relative to the Claude config folder, or absolute |
| `fiveHourWrapUp` / `fiveHourStop` | `85` / `90` | 5-hour thresholds in % |
| `weeklyWrapUp` / `weeklyStop` | `90` / `97` | Weekly thresholds in % |
| `extraNote` | empty | Text appended to every guard note |
| `contextBudget` | `300000` | Budget until Claude sets one for the task; `0` turns the context budget off |
| `contextCap` | `800000` | The largest budget Claude sets on its own; above it only when you ask |

Set them when installing (`--config key=value`, repeatable), later in `/plugin` (the plugin's configure screen), or from a shell:

```
echo '{"fiveHourWrapUp":"70","handoffFolder":"docs/handoffs"}' | claude plugin configure toolkit@ascalonv --values-stdin
```

A value that isn't valid (not a number from 1 to 100, wrap-up not below stop, an empty folder) falls back to its default, and the session shows a one-line notice.

## Effort skills

The plugin ships four skills, `toolkit:effort-low`, `-medium`, `-high` and `-xhigh`. Each one sets Claude's thinking effort for the rest of the turn. The plugin also adds these rules to Claude's instructions:

- The default is your effort setting: the one `/effort` keeps for the current model (`modelSettings`), else a plain `effortLevel`, else `high`. For a turn with tool work, Claude picks a level from the skill descriptions and, if it differs from the default, invokes that skill in the same message as its first tool call. A turn without tool calls doesn't switch.
- Claude names the level in one line of every reply, e.g. `Effort: low (bookkeeping)`. You override it with `/effort`.
- When unsure, Claude keeps the default. `max` only when you ask for it.
- Subagents for searching or exploring run at `effort: low`.

| Level | Fits |
| --- | --- |
| low | bookkeeping, notes, lookups, reading or listing files, running a known command |
| medium | changes of a known shape: config edits, renames, version bumps, docs, a fix whose cause is clear |
| high | new features, bugs with an unknown cause, multi-file changes, reviewing test feedback |
| xhigh | architecture or design decisions, tricky performance or concurrency work, a second try after a failed fix |

A project can bring its own, more tailored effort skills: an `effort-<level>` skill in `.claude/skills/` of the working directory or the project root. The rules then name the project's skill for that level instead of `toolkit:effort-<level>`, and tell Claude to use it. Levels the project doesn't cover keep the plugin's skill.

Turn the rules off with the `effortRules` setting; the skills stay available either way.

## Agents

### Project rules for subagents

A project can give its subagents rules of their own: which files they may touch, where they keep notes, how they report back. Put them in `.claude/agent-rules.md`, in the project root or the working directory. The plugin adds the file's text to the end of every new subagent's prompt, so the agent has the rules before its first request. Resumed agents already have them. Projects without the file see no change.

Turn it off with the `agentRules` setting.

### Starting agents on its own

By default, Claude Code starts subagents only when you ask for them. With `agentUse` on, the plugin adds a rule to the main chat's instructions: start agents without being asked whenever work splits into parallel, independent parts, keep small or tightly coupled work in the main chat, give each agent its own files and a self-contained prompt, and skip agents for quick one-off tasks. Subagents themselves don't get this rule.

It is off by default, because every agent starts with an empty context and costs tokens. Turn it on per machine:

```
echo '{"agentUse":"true"}' | claude plugin configure toolkit@ascalonv --values-stdin
```

## Context budget

Every request sends the whole conversation, so a long chat costs more with every turn. Compacting early saves tokens, but in the middle of complex work a compaction drops details that matter. So Claude picks the budget per task:

| Budget | Fits |
| --- | --- |
| ~200k | bookkeeping, small fixes, tasks that split well across handoffs |
| 300k | normal feature work (the default until a budget is set) |
| 500k to the cap | complex work where a compaction would cost quality: debugging or rendering across many files, large refactors, long log analysis |

- At the start of every task, also a new task in the same chat, Claude sets the budget with the plugin's `ContextBudget` tool and names it in its effort line, e.g. `Effort: high (new feature) · Context: 300k`. Ask for another size any time.
- Above `contextCap` (800k) only when you ask; never above the model's window.
- **At 90 % of the budget it's decision time**, checked before every request of the main chat, so Claude hears it mid-turn:
  - the task needs the context: Claude raises the budget and carries on, or
  - otherwise Claude finishes the current step, fills in the handoff, asks for a compaction (`compact: true`) and ends its turn. With `carryOn: true` (the task isn't finished and needs nothing from you) the plugin starts the next turn by itself after compacting, from the handoff; without it, it waits for you.
- A new budget gets its own 90 % note, also when the context is already past 90 % of it.
- **The plugin never compacts on its own**, so nothing is summarized before Claude has saved what matters. Past the budget Claude is reminded again, at 100 % and every further 10 %. If it still doesn't decide, Claude Code's own compaction near the model's window is the safety net.
- At the usage guard's stop stage, nothing resumes by itself.
- **Your messages come first.** A queued message that starts a turn before the compaction runs moves it to the end of that turn, and Claude is told: it answers you, and asks again with `carryOn` if the task should still resume afterwards (otherwise the plugin waits for you). A message you type while the compaction runs goes before the plugin's "continue" prompt, which is then not sent; Claude reads beside your message that the task was meant to resume, and carries on unless your message changes it.
- Headless sessions (`claude -p`, SDK hosts such as the IDE extensions) compact through the `/compact` command, since the plugin API's own compaction isn't available there yet. A compaction refused for any other reason is reported to Claude once, with the reason.
- The budget Claude set, a compaction it asked for and the task's handoff file survive a plugin reload or update (`$.state`). `/clear` and `/resume` start them over, and so does a new process (`claude --resume`). A budget Claude never set follows the `contextBudget` setting, also after you change it.
- The status line shows `ctx 95k/300k`. The rules in Claude's instructions name the default from the settings, so they read the same whatever budget is set.
- A turn runs from your message until Claude's reply ends; the plugin compacts between turns, so Claude Code's own compaction stays as the safety net for one extremely long turn. Don't set `autoCompactWindow` below the cap: Claude Code would compact there before a larger budget is reached.

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
