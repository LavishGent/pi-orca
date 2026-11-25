# Changelog

## [Unreleased]

- Add `orca_worktree_create`: one new Orca worktree and branch in the session's
  repository, with setup skipped and no parent. Journaled before and after.
- `orca_worker_start` accepts `worktree`, the name of a worktree this session
  created. Orca must report it live, local, non-bare and in the same repository.
  Existing read-only and edit rules apply unchanged inside it.

## [0.2.0]

- Add `orca_doctor`, `/orca-doctor [agent]` and a standalone diagnostic script.
- Locate Pi/harness executable candidates without executing them. Only Git root
  and local Orca worktree metadata are actively requested. Report unknown
  authentication, versions, vendor/account identity, quota and live operation.
- Bundle optional `pi-orca-setup` guidance, official prerequisite links and an
  explicitly authorized worker-test walkthrough. One test task may use multiple
  billable requests; it is not run by diagnostics or skill loading.
- Existing launch, mailbox, delivery and edit permissions remain unchanged.

## [0.1.0]

First public GitHub Pi package.

- Automatic session-owned Orca mailbox setup and verified reconnection.
- Read-only workers by default; opt-in edits to explicit clean or new files.
- Foreground report delivery with private receipts and safe reoffers after reload.
- Durable launch uncertainty barriers, session locks and terminal/Run ownership claims.
- A bundled pi-orca routing skill and optional external inventory adapter.
- Source/SDK tests, public-content checks and macOS/Linux CI.

Experimental. No automatic stale-mailbox replacement, global writer lock,
account-bound quota routing or OS sandboxing is provided.
