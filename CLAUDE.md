# claude-toolkit

<!-- fleet:project v2: from /fleet-project (the Claude Fleet dashboard reads these files); a newer block replaces it -->
## Tasks, ideas and handoffs (Claude Fleet dashboard)

The dashboard's task board and Active batches come from `BACKLOG.md`, `IDEAS.md` and `handoffs/`. Keep them in the
format of `~/.claude/skills/fleet-project/FORMAT.md`; `fleet project check` lists what the dashboard can't read.

- **Tasks:** one row per task in BACKLOG.md's overview table (`# | Task | Where | Now | Status`), with a number that
  stays for good. Update `Now` whenever who acts next changes: `you: <what the user answers>`, `test: <what the user
  tests>`, `claude: <what Claude does next>`, `open`, `paused: <why>`, `done`, `released: <version>`; several parts
  split by `;`. Status is a log: add `; <step>` at its end (newest last). Details of a task go in a section below the
  table.
- **Ideas:** when the user says to note something for later, add it to IDEAS.md under its `## <area>`:
  `- **I-<next number>** · <date> · new · **<short title>**`, with the user's words quoted below. Build nothing.
  When the user picks one, it becomes a BACKLOG task and the idea says `planned → task <n>`.
- **Handoffs:** a task that takes more than one chat keeps `handoffs/<date>-<slug>.md`: `# <title>` (what the work
  is now), `Updated: <date> · Status: open`, `Tasks: <n> <name>, …` when it carries BACKLOG tasks, the session id on
  a `Sessions:` line, and `## Goal` with one short paragraph. Keep the title and Goal true as the work moves on; a
  finished task leaves the file (its BACKLOG row moves on); the last one out sets `Status: done`.
- **Outputs for the user's main PC:** everything the user should take off this machine (a build to test, a release,
  an export, a report, images to look at) goes into this project's output folders: `out/` unless
  `fleet project list` names others for this project. The dashboard copies new and changed files from there to the
  shared folder (`<outbox>\<project>\…`) within seconds; never write into the shared folder yourself. One file per
  version with the version in its name (`app-1.2.0-test.3.zip`); remove what is outdated, and the share follows. No
  secrets, no intermediate build files. When something is ready, tell the user its name and that it's in the outbox.
<!-- /fleet:project -->
