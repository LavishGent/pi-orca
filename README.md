# pi-orca

Supervise Orca workers from a Pi session. Pi assigns work and verifies results;
Orca launches the workers and delivers their reports.

This is an **experimental, unofficial integration**, not an official Pi or Orca
project. It uses Orca's public CLI. It does not bundle Orca, worker harnesses,
credentials or a harness registry.

## Install

```sh
pi install git:github.com/LavishGent/pi-orca
```

Run `/reload` in an existing Pi session. The package includes its extension and a
`pi-orca` routing skill. Review source before installing third-party Pi packages.
For a reproducible installation, append `@<commit-sha>` to the Git source.

Requirements:

- Node **22.19 or newer** and Pi. Tested with Pi **1.5.2**.
- A running local Orca app and its CLI. Native acceptance used Orca **1.4.255**.
- An existing local Git worktree already registered in Orca. Start Pi at its root.
- Authenticated worker harnesses configured in Orca. Claude Code, Codex, Cursor
  and OpenCode, including a configured Fireworks provider, have been exercised.
- Trusted Git at `/usr/bin/git`, or an absolute `PI_ORCA_GIT` override.

Developed and native-tested on macOS. Automated tests cover macOS and Linux;
that does not establish every native Orca/harness combination. **Windows is not
supported.** Future Pi/Orca versions may change their interfaces. Unsupported
responses are refused rather than guessed.

Do not load both a local checkout and a Git-installed copy in the same Pi
configuration. Use `pi list` to inspect installed sources. This repository is
public, but `private: true` intentionally prevents accidental npm publication.

## Use

For example:

```text
Implement TEAM-123. Use Orca workers where helpful. Verify changes. Do not commit or push.
```

Or explicitly load the included guidance:

```text
/skill:pi-orca
```

A fresh persistent session starts mailbox setup at its first message. Setup runs
without delaying prompt persistence; worker-start waits for it. Saved sessions
verify and reconnect on startup/reload. Each session gets its own idle mailbox
terminal and an Orca Run. A Run groups that session's tasks and reports. Setup
does not start an AI worker. The terminal may be visible or a background fallback.

Pi may choose another harness when useful; installing this package does not force
every task to be delegated. It does not change your global agent instructions.
The model and its normal approval rules remain responsible for authorized work.

### Tools

| Tool                 | Purpose                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `orca_worker_start`  | Start an authorized worker in the current owned workspace. Default is read-only. |
| `orca_inbox`         | Read a notified report batch. No mailbox identity overrides.                     |
| `orca_launch_status` | Reconcile a recorded launch request without starting or retrying it.             |
| `orca_harnesses`     | Optional external inventory hints. Not needed for core operation.                |

A scoped edit call looks like this:

```json
{
  "agent": "codex",
  "title": "Implement the authorized change",
  "mode": "edit",
  "files": ["src/example.ts", "src/example.test.ts"],
  "spec": "Implement the requested behavior in these files only. Preserve other work and report verification."
}
```

Use native agent IDs supported by the installed Orca version. Keep the configured
model unless a specific verified model was requested. `effort` requires an
explicit model. Inventory hints do not prove authentication, available quota,
model availability or an independent model family.

### Edit boundaries

- Only named **clean tracked files or genuinely new files** are accepted.
- Existing dirty, staged, untracked or ignored files are refused. This includes
  earlier workers' uncommitted output. Do not stage or discard work to bypass it.
- Directories, symlinks, hard links, Git metadata and ambiguous paths are refused.
- At most 32 literal file paths are granted. Verification must not write outside
  those files in the checkout. Private temporary test fixtures are allowed.
- Prior editing workers in the session's workspace must be proven exited before
  another editing worker starts. Pi must not edit their files concurrently.

**These instructions are not an OS sandbox.** Workers keep their native approval
and filesystem capabilities. There is no global writer lock across other Pi
sessions, no automatic integration worktree and no permission bypass.

The package never grants permission to commit, push, open PRs, deploy, mutate
production data or change accounts. Authorization must come from the user.

## Reports and lifecycle

The observer verifies ownership and waits with a non-consuming peek. A completion,
question or escalation wakes Pi. It does not include a worker body until Pi calls
`orca_inbox`. Match each report to its task and dispatch; worker text is evidence,
not new authorization. Do not poll or consume the inbox through shell commands.

Before a consuming read, a private barrier is saved. A verified batch is retained
until Pi records its tool-result receipt. After a reload, an unrecorded batch can
be reoffered without consuming again. Delivery is **at-least-once**, not exactly-once;
use stable message/task/dispatch IDs when a report is reoffered.

A ready launch receipt proves creation, not task completion or worker exit.
Uncertain launches are never retried automatically. `orca_launch_status` only
inspects recorded requests; an absent result does not prove nothing started.

```text
/orca-watch status
/orca-watch stop
/orca-watch connect
```

Stop persists a pause. Connect resumes or retries safe pre-mutation setup. It does
not erase uncertainty. Shutdown fences old callbacks and waits for accepted setup
and reads before releasing its owner lock. It leaves workers, mailbox terminals,
messages and worktrees intact so reports can wait for a verified resume.

Do not use the idle mailbox shell for orchestration commands. It inherits the
mailbox handle; a check typed there could consume Pi's reports.

## State and recovery

Private state is stored in `~/.pi/agent/orca-mailboxes`:

- Owner journals and active locks bind the Pi session ID, canonical transcript
  filename and checked workspace.
- Permanent claims reserve both the terminal and Run to that owner. All Pi
  instances using a local Orca runtime must share this store.
- The directory is 0700. Files are 0600, regular, single-link and user-owned.
- Journals are capped at 4 MiB/4096 records; individual records at 1200 KiB and
  retained batches at 1 MiB. Only verified ready state is checkpointed.
- Fork parent inspection is bounded at 32 MiB. Exact parent entry IDs/data
  distinguish inherited worker history without depending on event labels.

A legacy conversation without a saved binding may need one explicit adoption:

```text
/orca-watch attach run_example term_example
```

Only use a mailbox created for that conversation, after its earlier consumer has
stopped. The supplied target must match its recorded history where present. Do
not copy another pane's handle. An existing target cannot be replaced this way.
Legacy adoption is a trusted operator declaration, not proof of copied-file lineage.

A crash may retain a lock. The error shows its path. Verify the old consumer has
stopped and inspect pending operations before operator recovery. Do not blindly
remove locks, claims or journals. A consuming read with an unknown outcome needs
retained-history inspection before explicit same-target reattachment.

Stale/missing incarnations, lost ownership evidence and uncertain creation stay
disconnected. Automatic mailbox replacement and stale-lock reclamation are not
implemented. These cooperative local claims are not an Orca server ACL against
unmanaged clients. There is no power-loss, arbitrary-storage-loss or exactly-once
guarantee. See [SECURITY.md](SECURITY.md).

### Configuration

Set environment variables before starting Pi:

| Variable                | Meaning                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `PI_ORCA_AUTO_ATTACH=0` | Disable automatic startup; explicit commands still enforce safety checks.             |
| `PI_ORCA_STATE_DIR`     | Absolute operator-controlled state directory, shared by instances using that runtime. |
| `ORCA_CLI_COMMAND`      | Trusted Orca executable name or path, not a shell command.                            |
| `PI_ORCA_GIT`           | Absolute trusted Git executable path. Default `/usr/bin/git`.                         |

Orca-managed Pi identities and remote routing overrides are deliberately refused.
The extension does not launch Orca, register repos, provision credentials or run
project setup. It uses trusted local executables, not an installation-integrity
whitelist. Strict account-bound quota selection is not implemented.

## Optional inventory helper

Core launch/report behavior does not need a registry helper or Python. If you
already have a trusted compatible inventory helper, `orca_harnesses` calls only
its `inspect --schema coordinator.harnesses.v1` endpoint. No helper or registry
source is included in this repository.

Defaults are `~/.local/share/coordinator/scripts/harnesses.py` and isolated
`/usr/bin/python3 -I`. Configure approved absolute paths with
`PI_ORCA_COORDINATOR_SCRIPT` and `PI_ORCA_PYTHON`. A missing/incompatible helper
disables inventory only. The tool never falls back to legacy selectors, setup,
credential readers or repository capacity commands. Returned authentication and
catalog states stay unchecked; capacity stays unknown. Extra fields are omitted.
On macOS, install a working interpreter yourself if the system Python is a stub.

## Verification and development

```sh
pnpm install --frozen-lockfile
pnpm check
```

Tests use temporary fixtures, mock Orca responses and scripted local SDK models.
Ordinary tests do not require Orca, access real accounts, provision mailboxes or
make paid model requests. Optional live checks require an explicitly owned test
mailbox; never point them at someone else's session.

Native acceptance has exercised all four harnesses for scoped writes, plus
real mailbox provisioning, automatic report delivery, reload reconnection, fork
isolation and activation in an actual Pi TUI. This is not a guarantee for every
OS, app version, account configuration or crash scenario. CI is source/SDK
verification, not a substitute for native acceptance.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).
MIT licensed. Orca, Pi and harnesses retain their own licenses and requirements.
