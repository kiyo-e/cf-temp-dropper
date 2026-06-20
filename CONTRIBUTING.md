# Contributing

Thanks for your interest in improving `cf-temp-dropper`.

## Local setup

Use Node.js 22 or newer.

```bash
npm install
npm run build
npm run smoke
```

## Development workflow

1. Create a branch for your change.
2. Keep changes focused and small.
3. Update `README.md` when behavior or user-facing commands change.
4. Run the verification commands before opening a pull request.

```bash
npm run build
npm run smoke
npm pack --dry-run
```

For changes to deploy behavior, also test a real temporary deployment using a non-sensitive sample file.

## Design principles

- Keep the generated Worker and UI simple enough to inspect.
- Prefer temporary-account-safe defaults.
- Avoid requiring Cloudflare login for the default path.
- Keep user-facing copy plain; implementation details belong in docs, not the landing page.
- Do not add external CDN dependencies to the generated page unless there is a strong reason.

## Reporting bugs

Please include:

- OS and Node.js version
- `cf-temp-dropper` version
- command used
- file size and MIME type, if relevant
- full error output, with secrets redacted
- whether the failure happened during generation, dependency install, deploy, preview, or verified save

## Security issues

Please do not open public issues for sensitive vulnerabilities. See `SECURITY.md`.
