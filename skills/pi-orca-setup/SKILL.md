---
name: pi-orca-setup
description: Check pi-orca prerequisites, guide optional installation and sign-in for one selected harness, and explain or run an explicitly authorized worker test. Use when the user asks to onboard or troubleshoot setup.
---

# Set up Pi-Orca

Start by asking which existing harness the user wants to use: Claude Code, Codex,
Cursor or OpenCode. One is enough. Do not install or activate all four. Loading
this skill requests assistance, not permission for installers or model requests.

## Check before changing anything

Call `orca_doctor` with the selected native agent ID (claude, codex, cursor or
opencode), or omit the selection if undecided. Explain failures and skipped or
unknown facts. Candidate presence is not proof of vendor identity, version,
authentication, selected account, quota or successful inference.

Diagnostics passively locates candidate files. It does not execute Pi or worker
CLIs or inspect their configuration. Its only active checks request Git root and
local Orca worktree metadata. Trusted metadata CLIs may do their normal logging,
cache or startup I/O. Diagnostics itself does not install, launch services,
register resources, consume mail or start models. An existing Pi session may
independently perform normal automatic mailbox attachment. Setting
PI_ORCA_AUTO_ATTACH=0 before starting Pi disables only that automatic attachment,
not Pi itself or other extensions.

Pi must run in an external terminal at a Git root already registered in local
Orca. A managed identity or remote override is not something to bypass by
clearing environment variables. Never borrow a terminal or mailbox from another
session, change branches, discard files or delete state to pass a check.

## Offer a specific next step

Official prerequisite instructions:

- Node: https://nodejs.org/en/download (22.19 or newer).
- Pi: https://pi.dev/ (this package has been tested with Pi 1.5.2).
- Git: https://git-scm.com/downloads.
- Orca: https://www.onorca.dev/docs/install (native tests used Orca 1.4.255).
- Claude Code: https://code.claude.com/docs/en/setup.
- Codex: https://developers.openai.com/codex/cli/.
- Cursor: https://cursor.com/docs/cli/installation.
- OpenCode: https://opencode.ai/v2/docs/.

Ask before executing installers, launching applications, registering a repository,
changing shell PATH or native skills, or selecting an account/provider. Explain
exactly which change is proposed. Reuse working installations and preserve their
settings. Verify official vendor instructions before executing a version-specific
command. Inspect downloaded installers before running them. Do not replace a
working executable or accept license terms for the user.

For Orca registration, read the selected installed CLI's version-matched native
guide. Reuse the existing clone/worktree, confirm exact path and local host, and
ask before registering it. Do not create another checkout or install a separate
coordinator. On Linux use the selected Orca CLI, normally orca-ide, not the GNOME
screen reader. Respect an explicit trusted ORCA_CLI_COMMAND override.

Let the user complete browser sign-in using their chosen harness's official
authentication instructions. Do not inspect credential files, keychains,
databases, exported credentials or private provider configuration. Do not change
accounts, obtain API keys, enable paid overages, purchase subscriptions or choose
a different billing provider to complete setup. Allow any step to be deferred.
Keep a short credential-free account of checked facts and remaining user actions.
Unknown is an acceptable result. Recheck prerequisites after approved changes.
Windows is unsupported; do not improvise a Windows installer.

## Optional worker test: explicit consent required

Explain the cost before dispatch: this is one worker task and may make multiple
billable model requests, including Pi's report-handling turns. There is no fixed
request-count cap. It creates normal task/journal/report records. A prerequisite
check or skill invocation is not consent. Ask which configured harness to use and
obtain explicit permission for this test before launching it.

Use existing `orca_worker_start`, default read-only, without a model override.
Choose a unique marker for this attempt and include it in a self-contained spec:
return that marker, do not inspect repository files, run task commands, edit,
commit or perform unrelated network work. The native Orca worker_done completion
protocol supplied to the worker is the explicit exception to the no-tools rule.
Normal harness startup may read configuration; read-only is not an OS sandbox.

Record the ready task/dispatch IDs and marker. End the turn and await automatic
notification. Then call `orca_inbox`; only its returned report exposes the body
and completion evidence. Match the exact task/dispatch, succeeded outcome and
marker before declaring that attempt demonstrated. An unrelated report does not
complete the target test.

A saved report reoffered after reload can be the first usable evidence of
success. Accept it if it matches the still-pending attempt. If existing transcript
evidence shows the attempt was already accepted, keep it accepted and do not
count or launch it again. Use stable message/task/dispatch IDs; do not create a
new acceptance store. A failed or malformed target report is not success.

On an uncertain launch use `orca_launch_status` on its recorded request. Do not
resend, poll, consume through CLI checks or switch providers. Report failed or
unknown results honestly. Completion does not prove process exit; follow the
installed native guide for guarded lifecycle inspection/release. Never close
arbitrary terminals or delete another session's state.

A successful test demonstrates one execution/report path for that harness and
configuration at that time. It does not verify available quota, exact account
binding, all other harnesses or future readiness.
