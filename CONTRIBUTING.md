# Contributing

Thanks for helping improve DSH Engineering Protocol.

## Development requirements

- Node.js 22.19.0 or newer (the plugin's declared runtime floor).
- A checkout of this repository.
- For the browser suite, a Chromium-based browser such as Microsoft Edge, Chrome, or Chromium.

The core test suite uses fake hosts and fake model responses; it does not require model credentials.

## Test commands

```sh
npm run test:core
npm run test:browser
npm test
```

The browser suite uses `ENG_PROTOCOL_BROWSER` when set. Point it at the browser executable available on your machine. On Windows, the suite's default is Microsoft Edge at its standard installation path.

## Change guidelines

1. Reproduce a bug with a focused regression test before changing behavior.
2. Preserve fail-closed behavior for enforceable checks and never turn unknown evidence into a successful verdict.
3. Keep session-scoped dashboard data isolated. Do not silently fall back to another session or project.
4. Do not commit real DSH configuration, API keys, private conversation logs, evidence snapshots, or other local state.
5. For model-related changes, test partial output, cancellation, timeouts, malformed responses, and retry limits with deterministic fake responses.
6. Document any runtime requirement or behavior change in the README.

## Pull requests

Describe the user-visible problem, the root cause, the behavioral change, tests run, and any remaining limitations. Separate measured results from hypotheses; do not claim a latency or quality improvement without representative measurements.
