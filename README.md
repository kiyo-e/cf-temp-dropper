# cf-temp-dropper

Create a temporary Cloudflare-hosted file drop from one local file.

`cf-temp-dropper` splits a file into Workers Static Assets, generates a small Hono Worker, and deploys it with `wrangler deploy --temporary`. The resulting page can preview media through `/file` range streaming and save a checksum-verified copy through parallel chunk download.

Temporary Cloudflare preview deployments are meant for short-lived sharing. Claim the deployment in Cloudflare if you need it to live longer than the temporary preview window.

## Features

- **No Cloudflare login required for the default path** — uses Wrangler temporary accounts.
- **Temporary public URL** — Wrangler prints a `workers.dev` URL and a claim URL.
- **Static asset chunking** — defaults to 4.75 MiB chunks for temporary-account safety.
- **Media preview** — image, audio, and video files can preview on the page.
- **Range streaming** — `/file` supports `HEAD` and `Range` requests for media players.
- **Parallel verified save** — downloads chunks in parallel, caches completed chunks in IndexedDB, assembles the file, and verifies SHA-256 before offering the saved copy.
- **Hono-based Worker** — generated Worker code is small and inspectable.

## Quick start

```bash
npx cf-temp-dropper ./movie.mp4
```

After deployment, Wrangler prints something like:

```text
https://temp-drop-movie-mp4-xxxx.example.workers.dev
Claim URL: https://dash.cloudflare.com/claim-preview?claimToken=...
```

Open the URL to preview supported media or save the verified file.

### Direct download with curl

The generated Worker also exposes the original file at `/file`, so command-line download works without using the browser UI:

```bash
curl -L -o movie.mp4 https://<your-worker>.workers.dev/file
```

Resume an interrupted download with curl's continue mode:

```bash
curl -L -C - -o movie.mp4 https://<your-worker>.workers.dev/file
```

`/file` is served with `Content-Disposition: inline` so browsers can preview media. Because of that, `curl -OJ https://.../file` may save the file as `file` instead of the original filename. Use `-o <filename>` when you want a predictable local name.

## Requirements

- Node.js 22 or newer
- npm / npx
- Network access to install dependencies and run Wrangler

You do **not** need to be logged in to Cloudflare for the default temporary deployment flow. The CLI intentionally removes common Cloudflare credential environment variables when running `wrangler deploy --temporary` so Wrangler uses a temporary account instead of your real account by accident.

## Usage

```bash
cf-temp-dropper <file> [options]
```

Examples:

```bash
# Deploy a temporary file drop
npx cf-temp-dropper ./recording.mp3

# Keep the generated Worker project after deployment
npx cf-temp-dropper ./recording.mp3 --keep

# Generate only, then inspect or run locally
npx cf-temp-dropper ./recording.mp3 --no-deploy --out ./drop-build --yes
cd ./drop-build
npm install
npm run dev

# Use a custom generated Worker name
npx cf-temp-dropper ./archive.zip --name temp-archive-share
```

Options:

| Option | Default | Description |
|---|---:|---|
| `--chunk-size-mib <n>` | `4.75` | Chunk size in MiB. Must be `<= 5` for temporary accounts. |
| `--parallel <n>` | `6` | Browser-side chunk download concurrency. |
| `--out <dir>` | temp dir | Generated Worker project directory. |
| `--name <name>` | derived from file | Cloudflare Worker name. |
| `--no-deploy` | `false` | Generate the Worker project but do not deploy. |
| `--keep` | `false` | Keep the generated temp project after deployment. |
| `--yes`, `-y` | `false` | Non-interactive overwrite of `--out`. |
| `--help`, `-h` | — | Show CLI help. |

## How it works

1. Computes the file SHA-256 and MIME type.
2. Splits the file into static asset chunks under `public/chunks/`.
3. Writes a `manifest.json` containing file metadata and per-chunk hashes.
4. Generates a Hono Worker with:
   - `/` static page
   - `/manifest.json`
   - `/file` full-file streaming endpoint
   - `HEAD /file` with `Content-Length` and `Accept-Ranges`
   - `Range: bytes=...` support across chunk boundaries
5. Runs `npm install` in the generated Worker project.
6. Runs `wrangler deploy --temporary`.

## Preview vs verified save

The page has two paths:

- **Preview** uses `/file` directly. For audio/video, the browser can request byte ranges and seek without downloading the entire file first.
- **Save verified copy** downloads chunk assets in parallel, stores completed chunks in IndexedDB, assembles a `Blob`, verifies the full SHA-256, then offers the file for saving.

This keeps media preview responsive while still giving users a verified full-file download path.

## Limits

Cloudflare temporary preview deployments have stricter limits than normal claimed Workers deployments. This tool is intentionally conservative:

- each generated static asset chunk must be at most **5 MiB**
- the generated deployment must fit within **1,000 static files**
- default chunk size is **4.75 MiB** for headroom

As a rough guide, 1,000 chunks at 4.75 MiB is about 4.6 GiB before accounting for generated files. Browser memory and storage can become the practical limit before Cloudflare limits do, especially for verified save of very large files.

## Privacy and security notes

- The deployed URL is public to anyone who has the link.
- Temporary deployments should be treated as short-lived public shares, not private storage.
- Do not upload secrets, credentials, personal documents, or regulated data unless you are comfortable with public-link access.
- Generated chunks are static assets. The Worker reconstructs the file for streaming and download; it does not encrypt file contents.
- Claiming a deployment moves it into a Cloudflare account and may change its lifetime and management model.

## Development

```bash
npm install
npm run build
npm run smoke
```

Useful commands:

```bash
# Type-check only
npm run check

# Build package contents without publishing
npm pack --dry-run

# Generate a local Worker project for inspection
node dist/cli.js fixtures/sample.txt --no-deploy --out .tmp/smoke --yes
```

Project layout:

```text
src/cli.ts           CLI, generated Worker, generated UI
fixtures/sample.txt  smoke-test input
README.md            user/developer documentation
LICENSE              MIT license
```

## Publishing checklist

Before publishing to npm or GitHub:

- [ ] Set the final repository URL in `package.json` if desired.
- [ ] Run `npm run build`.
- [ ] Run `npm run smoke`.
- [ ] Run `npm pack --dry-run` and inspect included files.
- [ ] Try a real temporary deployment with a non-sensitive sample file.
- [ ] Create a GitHub release or npm tag from the same version.

## License

MIT — see [LICENSE](./LICENSE).
