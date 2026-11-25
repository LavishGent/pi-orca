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

## Quickstart

### 1. Check prerequisites

You need Node, Pi, Git, local Orca and **one** chosen worker harness. You do not
need all four harnesses, Python, mise, Docker, Google Cloud or an inventory helper.

| Prerequisite           | Official installation instructions                         |
| ---------------------- | ---------------------------------------------------------- |
| Node 22.19+            | [nodejs.org](https://nodejs.org/en/download)               |
| Pi                     | [pi.dev](https://pi.dev/)                                  |
| Git                    | [git-scm.com](https://git-scm.com/downloads)               |
| Orca app and CLI       | [Orca installation](https://www.onorca.dev/docs/install)   |
| Claude Code, if chosen | [Claude Code setup](https://code.claude.com/docs/en/setup) |
| Codex, if chosen       | [Codex CLI](https://developers.openai.com/codex/cli/)      |
| Cursor, if chosen      | [Cursor CLI](https://cursor.com/docs/cli/installation)     |
| OpenCode, if chosen    | [OpenCode documentation](https://opencode.ai/v2/docs/)     |

Start Pi in an **external terminal**, not an Orca-managed terminal, at the Git
root of a checkout already registered in Orca. Then run:

```text
/orca-doctor codex
```

Replace codex with claude, cursor or opencode. Omit it to check the shared
prerequisites before choosing a harness. The model can call `orca_doctor` too.

The check does not execute Pi or worker CLIs. It finds executable candidates,
then requests only Git root and local Orca worktree metadata. Trusted metadata
CLIs may perform normal logging, cache or startup I/O. Diagnostics writes no
persistent report and does not install tools, start Orca, register repositories,
read credentials, consume mail or make model requests. Executable presence alone
does not verify vendor identity, versions, login, account binding or quota.

| Result                | Meaning and next step                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `blocked`             | A required candidate or metadata check failed. Follow the reported action; no automatic repair was attempted. |
| `live-test-required`  | Checked prerequisites passed. Authentication and actual worker operation are still unverified.                |
| `skipped` harness     | No harness selected. Choose one for a later worker test; this is not an all-four requirement.                 |
| `unknown` information | Not inspected or established. Do not treat it as readiness or spare quota.                                    |

Common fixes:

- Missing candidate: install from the official link or correct PATH. Verify that
  a generic `agent` executable really belongs to Cursor yourself.
- Apple Git launcher: diagnostics does not execute the macOS installer stub.
  With the default selection it looks for an existing Git in the standard Command
  Line Tools or Xcode installation. If neither can be found, install developer
  tools yourself or set `PI_ORCA_GIT` to an actual trusted Git executable. An
  explicit override pointing to Apple's stub is refused rather than substituted.
  This selection applies only to diagnostics. Edit validation still uses
  `PI_ORCA_GIT` or `/usr/bin/git`; a diagnostic pass does not prove Apple's launcher
  works or that Xcode's license has been accepted. Set `PI_ORCA_GIT` to your
  actual trusted Git executable if both paths need the same selection.
- Wrong directory: change to the Git worktree root, not a subdirectory.
- Missing Orca metadata: start Orca yourself and check registration of the exact
  existing checkout using its native guide. Do not create a replacement clone.
- Managed/remote identity: start a genuinely external local Pi session. Do not
  clear identity variables to disguise an Orca-managed session.
- Unsupported version: compare your installation with the tested versions above.
  Diagnostics intentionally does not run version commands for discovery.

A standalone check is also included. From a source checkout:

```sh
node scripts/doctor.mjs --agent codex --json
```

For the default Git installation, run it at the repository you want to check:

```sh
node ~/.pi/agent/git/github.com/LavishGent/pi-orca/scripts/doctor.mjs --agent codex
```

Use the actual package directory for a custom Pi installation layout. The
standalone script needs a Git/source installation outside `node_modules`, where
Node can strip TypeScript. For other package layouts, use `/orca-doctor` in Pi.
`--help`
performs no probes. Exit 0 means checked prerequisites passed, 1 means blocked or
cancelled, and 2 means invalid arguments. The standalone script does not load Pi
or its extensions. In an existing Pi session, normal automatic mailbox setup may
run independently of diagnostics. `PI_ORCA_AUTO_ATTACH=0` disables only this
extension's automatic attachment, not effects from Pi or other extensions.

### 2. Ask for setup help, if needed

```text
/skill:pi-orca-setup
```

The included skill explains the next steps for your selected harness and can
help with changes you approve. It asks before installers, application launch,
repository registration, PATH/skill changes or account/provider selection.
Browser login stays under your control. Existing installations/settings are
preserved; you can defer any step. Loading the skill is not blanket permission
for installations or a paid test. There is no bundled installer engine or
organization credential provisioning.

### 3. Explicitly authorize a worker test

After configuring and signing into your selected harness, give Pi this prompt:

```text
I authorize one read-only Orca worker test using Codex. I understand it may make
multiple billable model requests, including Pi's report-handling turns. Use the
configured model. Choose a unique marker and ask the worker to return it without
inspecting repository files, running task commands or changing anything. Allow
its native Orca completion protocol. Wait for automatic notification, then read
orca_inbox and verify the exact task/dispatch, succeeded outcome and marker.
Do not retry an uncertain launch or change accounts, providers or billing.
```

Choose your harness rather than assuming Codex is installed. This authorizes one
worker task, not a fixed number of inference requests. Native harness startup can
read its configuration. Read-only instructions are not an OS sandbox.

The report body is available only after `orca_inbox`, not in the notification.
A saved report after reload may be the first usable completion: accept it when it
matches the pending test. Keep an already accepted test accepted when its report
is reoffered; do not launch again. Unrelated reports do not complete the test,
and failed/malformed reports are not success. For unknown launches, inspect the
recorded request with `orca_launch_status` instead of resending it.

Success demonstrates that one worker executed and its report returned for that
configuration at that time. It does not prove spare quota, exact account
binding, all harnesses or future readiness. A successful report is not proof the
worker process has exited; use guarded native lifecycle guidance before cleanup.

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

| Tool                   | Purpose                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `orca_worker_start`    | Start an authorized worker in the current owned workspace. Default is read-only.         |
| `orca_worktree_create` | Create a new worktree and branch; workers can then target it with `worktree`.            |
| `orca_inbox`           | Read a notified report batch. No mailbox identity overrides.                             |
| `orca_launch_status`   | Reconcile a recorded launch request without starting or retrying it.                     |
| `orca_harnesses`       | Optional external inventory hints. Not needed for core operation.                        |
| `orca_doctor`          | Check prerequisite candidates and local metadata without installing or starting workers. |

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
make paid model requests. Onboarding report-acceptance fixtures use a scripted
consumer; they verify transport evidence and do not prove a real model follows
the skill. Real-model onboarding remains a separate opt-in acceptance check. Optional live checks require an explicitly owned test
mailbox; never point them at someone else's session.

Native acceptance has exercised all four harnesses for scoped writes, plus
real mailbox provisioning, automatic report delivery, reload reconnection, fork
isolation and activation in an actual Pi TUI. This is not a guarantee for every
OS, app version, account configuration or crash scenario. CI is source/SDK
verification, not a substitute for native acceptance.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).
MIT licensed. Orca, Pi and harnesses retain their own licenses and requirements.
