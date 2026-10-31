# claude-toolkit

<!-- fleet:project v5 db: from /fleet-project (this project keeps its work in the Claude Fleet project database); a newer block replaces it -->
## Tasks, ideas, tests and handoffs: the project database (Claude Fleet)

This project's tasks, ideas, questions, tests, builds, releases, decisions and handoffs are in the project database
(`~/.fleet/fleet.db`), written only with the `fleet` commands. Details: `~/.claude/skills/fleet-project/FORMAT.md`.

- **Views, never edited:** BACKLOG.md, IDEAS.md, PC-TEST.md, RELEASES.md, CHANGELOG.md and DECISIONS.md are written
  by fleet after each change (a hook refuses edits; a hand edit is overwritten). They are gitignored, so Grep skips
  them: search with `fleet find <words>`, read with `fleet board`, `fleet show <key>` (`--all`, `--history`),
  `fleet list --kind task --state active`, `fleet log`.
- **Text only from stdin**, never as an argument: Bash `fleet note 12 <<'EOF'` … `EOF`; PowerShell
  `@'` … `'@ | fleet note 12` (the here-string's closing `'@` at the start of its line). The first lines are the main
  text; a line that is only `::<field>` starts a field, and its text goes on the lines below the mark (never on the
  mark's line): `::words` the user's own words, verbatim; `::why`, `::next`, `::note`, `::goal`, `::a` `::b` …
  options or points. E.g. `fleet task set 12 --state active <<'EOF'`, then `::next`, `profile the start`, `EOF`, each
  on its own line. Text that looks like a secret is refused (`--force` when it is none).
- **Tasks:** `fleet task new [--where <component>] [--from I-<n>]` (stdin: title, `::words`, `::next`). Now is
  computed (open questions → you, waiting checks → test, `next` → claude): keep `next` true with
  `fleet task set <key> --state active` and `::next` (what Claude does next on the line below); a task that only
  waits for the user (an answer, a PC test) is `--state open`, else the board counts it as Claude's work;
  `--state paused|dropped` needs `::why`; `done` when built; `released` comes only from `fleet release`. Findings
  and progress: `fleet note <key>`; the user's words: `fleet note --user <key>`; plan steps: `fleet step <task>`,
  `fleet step done <key> [--commit <hash>]`.
- **Questions:** every question for the user, in chat or on a page, is `fleet ask <task> [--label <the number you
  show>] [--rec a]` (stdin: the question, `::a` `::b` options). The answer: `fleet answer <question> [<option>]`
  (stdin: a summary, `::words` the user's words). A thing the user has to do: `fleet ask <task> --do`.
- **Tests on the user's PC:** `fleet check new --task <key> [--build <component>@<version>]` (stdin: title, `::a`
  `::b` … points); it is numbered under that task (`148.T1`, points `148.T1.a`; checks from before 2026-10-31 keep
  their numbers). The board shows a check under its task's component, so each goes on a task of the component it
  tests, never one catch-all task for several; `fleet check set <key> --task <new> --untask <old>` moves one (its key
  stays). A wrong point while it waits: `fleet check set <key>` (`::b` the new text; `--build` another build it
  tests); the result: `fleet check result <key> passed|failed|partial [--point b=failed]` (`::words`).
- **Ideas:** when the user says to note something for later: `fleet idea new [--area <component>]` (stdin: a short
  title, `::words` the user's words). Build nothing. When the user picks one: `fleet idea start I-<n>`.
- **Builds and releases:** each build put into the outputs for a test: `fleet build <component> <version> --file
  <path> --carries <keys>`; a release: `fleet release <component> <version> [--includes …] [--carries …]` (stdin:
  release notes); where it went: `fleet deploy <version> --to <target>`. Pages, files and branches of a task:
  `fleet ref <key> --url|--file|--branch`. Decisions: `fleet decision new` (stdin: title, `::text`).
- **The user's message:** a hook lists the tasks, questions and tests it names. Before the turn ends, each one gets
  its change in the database, or `fleet ack <ref>` (stdin: why nothing changes); otherwise the turn is held once.
- **Commits** name their tasks in the message's last paragraph (with Co-Authored-By): `Task: <key>[, <key>]`, or
  `Task: none (<why>)`. The hook refuses a commit without it and records the hash on the tasks.
- **Handoffs** (a task that takes more than one chat): `fleet handoff new --task <keys>` (stdin: title, `::goal` one
  short paragraph, `::body`); it prints its ref `fleet:<project>:<slug>`: name that to ContextBudget (handoff) and
  give it to `/continue-task`. Read with `fleet handoff show <slug>` (it prints the rev); keep title and goal true
  with `fleet handoff set <slug> --rev <the rev you read>` (`::title`, `::goal`); the text with
  `fleet handoff write <slug> --rev <the rev you read>`; `--task`/`--untask <key>` as tasks join or leave;
  `fleet handoff close <slug>` when done. One open handoff per task: a chat on a task that has one
  (`fleet handoff list`) carries that one on, never starts another; if a new one must replace it, copy the old one's
  open points into the new one and close the old one (else the dashboard shows both). `handoff new` warns about this.
- **Agents** write only their notes: `fleet note --agent handoff <slug>`; every other fleet write is the main chat's.
- **Memory** holds no task, question or test state (the database has it; a hook warns).
- **Mistakes:** `fleet undo <#event>` (`fleet log` shows them); text that must go: `fleet redact <#note>`.
- **Outputs for the user's main PC:** everything the user should take off this machine (a build to test, a release,
  an export, a report, images to look at) goes into this project's output folders: `out/` unless
  `fleet project list` names others for this project. The dashboard copies new and changed files from there to the
  shared folder (`<outbox>\<project>\…`) within seconds; never write into the shared folder yourself. One file per
  version with the version in its name (`app-1.2.0-test.3.zip`); remove what is outdated, and the share follows. No
  secrets, no intermediate build files. Each file there is named by a `fleet build`, `fleet release` or `fleet ref`
  (else the dashboard warns). When something is ready, tell the user its name and that it's in the outbox.
<!-- /fleet:project -->
