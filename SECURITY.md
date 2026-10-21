# Security policy

## Reporting a vulnerability

Please do not open a public issue containing exploit details, credentials, private prompts, or evidence snapshots. Contact the repository owner privately through GitHub's profile/contact options and include:

- the affected commit or release;
- the affected endpoint, hook, or module;
- reproducible steps using synthetic data;
- impact and a suggested mitigation, if known.

Allow time for investigation before publishing details.

## Data-handling expectations

- Treat DSH configuration, model credentials, conversation transcripts, tool outputs, and evidence snapshots as potentially sensitive.
- Use synthetic fixtures in tests and scrub local logs before sharing diagnostics.
- Dashboard session scope is a security boundary: do not remove identity checks or silently substitute another session when the requested session is unavailable.
- Keep write operations and state-changing dashboard routes restricted to intended, same-origin clients.
- Avoid logging secrets or full user payloads in error messages.

## Scope

This policy covers this repository's plugin code, dashboard, test fixtures, and maintenance scripts. It does not imply that the host application or upstream model provider has the same security properties.
