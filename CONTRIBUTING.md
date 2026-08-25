# Contributing

Thanks for improving dsh-quota. Provider adapters, response fixtures, UI fixes and documentation updates are welcome.

## Development

Requirements: Node.js 22 or newer and a local DSH Web profile for runtime testing.

```bash
npm ci
npm run typecheck
npm test
npm run test:loader
```

Link the repository into a DSH Web profile for visual testing:

```bash
cd ~/.dsh/profiles/web
pnpm add link:/absolute/path/to/dsh-quota
dsh web
```

## Provider adapters

An adapter belongs in `src/host/adapters/` and must return a normalized `QuotaSnapshot`. Register its public metadata in `src/host/index.ts` and add response-fixture tests under `tests/`. A platform without a stable official account endpoint may be added as an explicitly labelled local-accounting route; it must not fabricate balance or quota values.

Adapter pull requests must:

- use an official, documented account or key endpoint;
- treat malformed, unauthorized and rate-limited responses as explicit states rather than zero balance;
- keep credentials out of snapshots, browser state, logs and thrown messages;
- include missing-key, healthy, authentication, rate-limit and malformed-response tests;
- document credential names and whether the value is account-wide or key-scoped.

Do not add arbitrary user-configured URLs that receive Host credentials. If a new endpoint is required, give it a fixed allowlisted origin in its adapter.

## Pull requests

Keep changes focused, update the changelog for user-visible behaviour, and attach before/after screenshots for UI work. All CI checks must pass.
