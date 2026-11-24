# Contributing

Use Node 22.19+ and the pnpm version declared in package.json.

```sh
pnpm install --frozen-lockfile
pnpm check
```

The check runs strict TypeScript, Node tests, the public-content audit and
formatting checks. Use `pnpm format` for the allowlisted source and documentation. Keep
runtime dependencies limited to Node built-ins and Pi host-provided types. The
bundled skill must work without a contributor's personal agent configuration.

Add failing regression tests before behavioral fixes. Mock Orca in ordinary
tests. Test fixtures may create private temporary Git repos and child processes;
clean up only their owned resources. Never run native tests against another
person's mailbox. Real-harness/native acceptance is a separate explicitly
controlled step, not a CI prerequisite.

Mailbox and launch journals are persistent formats. Preserve old permission
encodings and compatibility tests. Unknown outcomes must remain unknown; never
clear them by creating a new mailbox, retrying a mutation or discarding user work.
Scope is cooperative, not OS-enforced. Do not add approval-bypass flags.

Before sharing changes, inspect both the repository file list and the package
archive. Keep credentials, real account/terminal/session records, private plans,
logs, absolute personal paths and installed third-party bundles out of commits.
The public-content audit catches common mistakes; it does not replace review.
Do not copy a registry or third-party source without redistribution rights.

Explain behavior, verification and compatibility implications in a pull request.
Use public issues for ordinary bugs, but follow SECURITY.md for sensitive reports.
