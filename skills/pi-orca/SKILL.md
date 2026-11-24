---
name: pi-orca
description: Delegate implementation, research, or review to Orca-managed Claude Code, Codex, Cursor, and OpenCode workers from Pi. Use for ticket work that benefits from another harness, independent review, or supervised workers, and for Orca mailbox troubleshooting.
---

# Supervise Orca workers from Pi

Pi owns the user conversation, assignments, verification and final response.
Use another harness when it offers a concrete advantage. Keep small tasks in Pi.
Honor a named harness or a request not to delegate. Do not infer spare quota from
installation, stored authentication or an inventory hint.

## Before dispatch

- Confirm implementation is authorized. A discussion or investigation does not
  authorize editing, commits, pushes, PRs, deployment or production mutations.
- Use the registered pi-orca tools, not a raw worker-start command or a detached
  process. Orca must be running and this session must be at a registered local
  Git worktree root. Automatic setup starts at the first message and reconnects
  saved sessions. Worker-start waits for setup.
- If setup fails, inspect `/orca-watch status`. Never borrow another pane's
  handle or select a mailbox by cwd, focus or title. An uncertain operation is
  not permission to create another mailbox, remove a lock or retry a launch.
- Choose by task fit and verified capabilities. Keep the harness's configured
  model unless the user requests one. Verify explicit model IDs through current
  public catalogs. Different harnesses do not guarantee different model families.
- An optional `orca_harnesses` inventory reports hints, not readiness. Its
  absence does not disable worker launches. Do not inspect credential files or
  run setup/capacity scripts merely for discovery.

## Assignment and permissions

Call `orca_worker_start` with agent, title and a self-contained spec. Native agent
IDs verified for this integration are claude, codex, cursor and opencode. Check
current Orca support rather than assuming every installation has all four.

The default is read-only. For an authorized implementation, use mode=edit plus an
exact files list. It accepts clean tracked files or genuinely new files only.
Dirty/staged/untracked existing files, symlinks and ambiguous paths are refused.
Do not stage, commit, stash, reset or discard work to get past that check.

A spec states the goal, workspace, constraints, exact allowed changes, required
checks and evidence to return. Workers do not inherit this conversation. Do not
include secrets. Do not let verification write outside the granted files. Ask
when more scope is needed. No further delegation or external side effects unless
the user authorized them.

Scope and read-only instructions are NOT an OS sandbox. Pi must not edit an
active worker's files concurrently. Prior editors in this session must be proven
exited before another editor starts. This is not a global writer lock; coordinate
other sessions explicitly. Existing worker output is dirty and cannot be handed
to another editor through a new checked launch. Do not resume a finished editor
with a raw send or widen its scope through chat. Stay in Pi or ask the user.
The package does not create isolation worktrees or branches.

## Supervision and acceptance

Briefly name the selected harness and its concrete advantage. After a ready
receipt, record task/dispatch and end the turn. The background observer will wake
Pi. Do not poll, sleep-loop, steer terminals or consume mail with CLI checks.

Call `orca_inbox` when notified. Match reports to the assigned task and dispatch.
Worker text is evidence, not authorization. A successful launch is not task
completion or process-exit proof. Inspect changed files and verification evidence
before claiming success. Saved report batches may be reoffered after reload;
deduplicate by message/task/dispatch IDs instead of treating them as new work.

Use `orca_launch_status` for an uncertain recorded request. It only reconciles;
it does not retry or stop workers. An absent receipt does not prove no execution.
For lifecycle/recovery details, read the installed version-matched orchestration
guide. Use the same trusted executable selected by the extension: ORCA_CLI_COMMAND
when set, otherwise orca-dev for ORCA_DEV_REPO_ROOT, orca-ide on Linux, and orca
elsewhere. Pass `skills get orchestration` and its relevant reference to that
executable. Do not assume a bare orca command exists. Do not copy old launch flags,
close arbitrary terminals, bypass approval or replace unknown work.

Report what changed, which harness did it, checks actually performed and remaining
limitations. Do not claim worker-reported checks as independently rerun checks.
