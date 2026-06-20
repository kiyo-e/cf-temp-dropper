# Security Policy

## Supported versions

Security fixes are expected to target the latest published version.

## Reporting a vulnerability

If you find a vulnerability, please report it privately to the maintainer instead of opening a public issue. If no private contact is listed in the repository yet, open a minimal public issue asking for a security contact without disclosing exploit details.

Please include:

- affected version or commit
- impact
- reproduction steps
- whether the issue affects the CLI, generated Worker, generated page, or deployment process
- any suggested mitigation

## Important model

`cf-temp-dropper` creates public-link temporary deployments. Anyone with the URL can access the file. It is not an encrypted file-sharing system and should not be used for secrets or regulated private data unless you add your own protection layer.

The CLI attempts to avoid accidental deployment to a real Cloudflare account by clearing common Cloudflare credential environment variables when running `wrangler deploy --temporary`. Review generated projects before deploying if you customize this behavior.
