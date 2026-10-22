# account-statusline

A Claude Code status line that shows who is signed in and how much usage is left:

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

The first time, restart Claude Code once after installing so it picks up the new `statusLine` setting.

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

## Uninstall

Remove the plugin with `/plugin`, then delete the `statusLine` entry from `~/.claude/settings.json`.
