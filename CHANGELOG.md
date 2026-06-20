# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning where practical.

## [0.1.0] - 2026-06-20

### Added

- Initial CLI for creating temporary Cloudflare file drops.
- File splitting into temporary-account-safe static asset chunks.
- Generated Hono Worker with Workers Static Assets.
- `wrangler deploy --temporary` deployment flow.
- Generated landing page with media preview and verified save action.
- `/file` endpoint with full-file streaming, `HEAD`, `Content-Length`, `Accept-Ranges`, and byte-range responses across chunk boundaries.
- Browser-side parallel chunk download, IndexedDB resume, and SHA-256 verification before saving.
- Smoke test fixture and npm scripts.
