# Security and trust boundaries

This extension runs local code with the permissions of Pi. Review it before
installation. Orca and worker harnesses remain separate trusted applications with
their own authentication and approval controls. Executable paths are operator
configuration, not integrity proofs.

Read-only and file scopes are task instructions, NOT an OS sandbox. The package
checks eligibility before launch but cannot prevent a badly behaved worker or
another local process from modifying files. Coordinate concurrent sessions and
keep secrets out of worker specs and reports.

Private journals, locks and permanent mailbox claims protect cooperating Pi
instances using the same state directory. They are not server authorization
against arbitrary same-user CLI calls, older clients or manual state tampering.
Unknown mutations and reads are not automatically retried. Do not remove their
records or claim another session's mailbox to bypass a block.

Report batches can be retained locally until Pi persists their receipt. State
files are private, but their contents are not encrypted. Transcript and state
storage deserve the same care as any local development conversation. Do not
publish real state, logs, account data or credentials in issues.

For a sensitive report, use GitHub's private vulnerability reporting if available.
Otherwise ask the maintainer through their GitHub profile for a private reporting
channel without including the sensitive details. Do not post an exploit containing
secrets in a public issue. This experimental project has no guaranteed response
SLA; support is focused on the current published version.
