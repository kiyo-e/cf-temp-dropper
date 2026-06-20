---
name: cf-temp-dropper
description: "Use when a user wants to share a local file through a short-lived Cloudflare Workers temporary deployment, especially via npx cf-temp-dropper."
version: 0.1.0
author: kiyo-e
license: MIT
metadata:
  hermes:
    tags: [cloudflare, workers, file-sharing, temporary, npx, cli]
    homepage: https://github.com/kiyo-e/cf-temp-dropper
---

# cf-temp-dropper

Use `cf-temp-dropper` when the user wants to turn a local file into a temporary public Cloudflare-hosted download/preview page.

The tool:

- splits one local file into temporary-account-safe Workers Static Assets chunks;
- generates a small Hono Worker and static UI;
- deploys with `wrangler deploy --temporary`;
- prints a short-lived `workers.dev` URL plus a Cloudflare claim URL;
- exposes `/file` for direct streaming/download with `HEAD` and byte-range support;
- provides a browser UI with media preview and checksum-verified save.

## Quick command

```bash
npx --yes cf-temp-dropper@latest ./path/to/file
```

For reproducible tests, pin a version:

```bash
npx --yes cf-temp-dropper@0.1.0 ./path/to/file
```

## Recommended agent workflow

1. **Confirm the file exists** before invoking the tool.

   ```bash
   test -f ./path/to/file && stat -c '%n %s bytes' ./path/to/file
   ```

2. **Deploy through npx** unless the user specifically asks to use a local checkout.

   ```bash
   npx --yes cf-temp-dropper@latest ./path/to/file --yes --keep
   ```

3. **Capture both URLs from stdout:**
   - public page URL: `https://...workers.dev`
   - claim URL: `https://dash.cloudflare.com/claim-preview?...`

4. **Verify the public page and manifest.**

   ```bash
   curl -sSIL https://<worker>.workers.dev/ | sed -n '1,12p'
   curl -sS https://<worker>.workers.dev/manifest.json
   ```

5. **For direct file download, use `/file`.**

   ```bash
   curl -L -o <filename> https://<worker>.workers.dev/file
   ```

   Resume interrupted downloads:

   ```bash
   curl -L -C - -o <filename> https://<worker>.workers.dev/file
   ```

6. **Report the result succinctly:** page URL, claim URL, file name, size, SHA-256, and any verification performed.

## Dry run / local inspection

Use `--no-deploy` when the user wants to inspect generated files without uploading:

```bash
npx --yes cf-temp-dropper@latest ./path/to/file --no-deploy --out ./drop-build --yes
cd ./drop-build
npm install
npm run dev
```

Generated project layout:

```text
package.json
wrangler.jsonc
src/index.ts
public/index.html
public/styles.css
public/app.js
public/manifest.json
public/chunks/part-00000.bin
```

## Limits and expectations

- Temporary deployments are short-lived unless claimed in Cloudflare.
- The public URL is accessible to anyone with the link.
- Do not use this for secrets, credentials, regulated private data, or anything that must remain private.
- Default chunk size is 4.75 MiB for temporary-account safety.
- The tool refuses deployments that would exceed the 1,000 generated static-file limit.
- Browser verified-save uses IndexedDB and final `Blob` assembly, so very large files may hit browser storage or memory limits.
- `/file` is `Content-Disposition: inline` for media preview. `curl -OJ https://.../file` may save as `file`; prefer `curl -L -o <filename> https://.../file`.

## Useful examples

Deploy an audio file and verify media headers:

```bash
npx --yes cf-temp-dropper@latest ./recording.mp3 --yes --keep
curl -sSIL https://<worker>.workers.dev/file | sed -n '1,20p'
```

Expected useful headers:

```text
content-type: audio/mpeg
content-length: <bytes>
accept-ranges: bytes
content-disposition: inline; filename*=UTF-8''recording.mp3
```

Test a range request:

```bash
curl -sS -D headers.txt -H 'Range: bytes=0-99' -o segment.bin \
  https://<worker>.workers.dev/file
sed -n '1,20p' headers.txt
wc -c segment.bin
```

A good response is `HTTP 206` with `content-range` and exactly 100 bytes for `bytes=0-99`.

## Common pitfalls

- **No URL appears**: the command probably used `--no-deploy`; run without it for a live temporary URL.
- **Cloudflare deploy uses the wrong account**: the CLI intentionally clears common Cloudflare credential env vars before `wrangler deploy --temporary`, but local shell customization can still surprise you. Prefer the default `npx` path.
- **Temporary URL disappears**: expected for unclaimed temporary deployments; use the claim URL if persistence is needed.
- **`curl -OJ` saves as `file`**: use `-o original-name.ext` because `/file` is optimized for browser preview.
- **Large file fails in browser save**: preview may still work through byte ranges, but verified save can hit browser memory/storage limits.

## Verification checklist

Before telling the user it worked, verify at least:

- [ ] deploy command exited 0;
- [ ] public URL was printed;
- [ ] `curl -I <url>/` returns HTTP 200;
- [ ] `curl <url>/manifest.json` returns the expected file name, size, and SHA-256;
- [ ] if media/direct download matters, `curl -I <url>/file` returns `accept-ranges: bytes` and a correct content type.
