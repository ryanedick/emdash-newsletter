# Contributing

Issues and pull requests are welcome.

```bash
npm install
npm run typecheck
npm test
npm run build
```

- Tests use `node:test` against real SQLite (`node:sqlite`) behind a D1-compatible wrapper (`test/helpers.ts`), so SQL runs for real. Add a test with every change.
- Source imports use `.ts` extensions; `npm run build` rewrites them to `.js` in `dist/`.
- Never edit a shipped migration in `src/db.ts`; append a new one.
- Never change the key-derivation label in `src/crypto.ts` (`emdash-newsletters:settings-encryption`): stored provider credentials depend on it.
- **New email provider:** implement `EmailTransport` (`src/transport/types.ts`), add it to `PROVIDERS` and `createTransport` in `src/transport/factory.ts`, add a webhook parser in `src/events.ts`, and test the request shape with a fake `fetch`.
