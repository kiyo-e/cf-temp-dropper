#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile, cp, access } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { lookup as lookupMime } from 'mime-types';

const MIB = 1024 * 1024;
const STATIC_ASSET_MAX_MIB = 5;
const TEMPORARY_STATIC_ASSET_FILE_LIMIT = 1000;

type Options = {
  file?: string;
  chunkSizeMiB: number;
  parallel: number;
  out?: string;
  name?: string;
  noDeploy: boolean;
  keep: boolean;
  yes: boolean;
};

type Chunk = {
  index: number;
  path: string;
  size: number;
  sha256: string;
};

type Manifest = {
  version: 1;
  fileName: string;
  size: number;
  mime: string;
  sha256: string;
  chunkSize: number;
  createdAt: string;
  suggestedParallelism: number;
  chunks: Chunk[];
};

function usage(exitCode = 0): void {
  const out = exitCode === 0 ? console.log : console.error;
  out(`cf-temp-dropper

Usage:
  cf-temp-dropper <file> [options]

Options:
  --chunk-size-mib <n>  Chunk size in MiB. Default: 4.75. Max: 5 for temporary accounts.
  --parallel <n>       Browser download concurrency. Default: 6.
  --out <dir>          Output/generated Worker project directory.
  --name <name>        Cloudflare Worker name.
  --no-deploy          Generate only; do not call Wrangler deploy.
  --keep               Keep generated directory after deploy.
  --yes                Non-interactive; overwrite output directory if needed.
  -h, --help           Show this help.
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { chunkSizeMiB: 4.75, parallel: 6, noDeploy: false, keep: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') usage(0);
    if (arg === '--no-deploy') { opts.noDeploy = true; continue; }
    if (arg === '--keep') { opts.keep = true; continue; }
    if (arg === '--yes' || arg === '-y') { opts.yes = true; continue; }
    if (arg === '--chunk-size-mib') { opts.chunkSizeMiB = Number(argv[++i]); continue; }
    if (arg === '--parallel') { opts.parallel = Number(argv[++i]); continue; }
    if (arg === '--out') { opts.out = argv[++i]; continue; }
    if (arg === '--name') { opts.name = argv[++i]; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    if (!opts.file) opts.file = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!opts.file) usage(1);
  if (!Number.isFinite(opts.chunkSizeMiB) || opts.chunkSizeMiB <= 0 || opts.chunkSizeMiB > STATIC_ASSET_MAX_MIB) {
    throw new Error(`--chunk-size-mib must be > 0 and <= ${STATIC_ASSET_MAX_MIB}`);
  }
  if (!Number.isInteger(opts.parallel) || opts.parallel < 1 || opts.parallel > 32) {
    throw new Error('--parallel must be an integer from 1 to 32');
  }
  return opts;
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'file';
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function splitFile(inputPath: string, publicDir: string, chunkSize: number): Promise<{ chunks: Chunk[]; fileSha256: string }> {
  const chunksDir = join(publicDir, 'chunks');
  await mkdir(chunksDir, { recursive: true });
  const fileHash = createHash('sha256');
  const chunks: Chunk[] = [];

  let index = 0;
  let currentSize = 0;
  let currentHash = createHash('sha256');
  let currentPath = join(chunksDir, partName(index));
  let out = createWriteStream(currentPath);

  const closeCurrent = async () => {
    await new Promise<void>((resolvePromise, reject) => out.end((err?: Error | null) => err ? reject(err) : resolvePromise()));
    if (currentSize > 0) {
      chunks.push({ index, path: `/chunks/${partName(index)}`, size: currentSize, sha256: currentHash.digest('hex') });
    } else {
      await rm(currentPath, { force: true });
    }
  };

  for await (const data of createReadStream(inputPath)) {
    let buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    fileHash.update(buffer);
    while (buffer.length > 0) {
      const room = chunkSize - currentSize;
      const slice = buffer.subarray(0, room);
      if (!out.write(slice)) await new Promise<void>((resolvePromise) => out.once('drain', resolvePromise));
      currentHash.update(slice);
      currentSize += slice.length;
      buffer = buffer.subarray(slice.length);
      if (currentSize === chunkSize) {
        await closeCurrent();
        index += 1;
        currentSize = 0;
        currentHash = createHash('sha256');
        currentPath = join(chunksDir, partName(index));
        out = createWriteStream(currentPath);
      }
    }
  }
  await closeCurrent();
  return { chunks, fileSha256: fileHash.digest('hex') };
}

function partName(index: number): string {
  return `part-${String(index).padStart(5, '0')}.bin`;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)));
  });
}

function temporaryWranglerEnv(workdir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_EMAIL',
    'CLOUDFLARE_API_KEY',
    'CF_API_TOKEN',
    'CF_ACCOUNT_ID',
    'CF_EMAIL',
    'CF_API_KEY',
  ]) delete env[key];
  const home = join(workdir, '.wrangler-temporary-home');
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  return env;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inputPath = resolve(opts.file!);
  const inputStat = await stat(inputPath);
  if (!inputStat.isFile()) throw new Error(`Not a file: ${inputPath}`);

  const fileName = basename(inputPath);
  const workerName = opts.name ?? `temp-drop-${slugify(fileName)}-${Date.now().toString(36)}`;
  const workdir = resolve(opts.out ?? join(tmpdir(), workerName));
  if (await exists(workdir)) {
    if (!opts.yes) throw new Error(`Output directory already exists: ${workdir}. Use --yes to overwrite.`);
    await rm(workdir, { recursive: true, force: true });
  }

  const publicDir = join(workdir, 'public');
  await mkdir(publicDir, { recursive: true });
  console.log(`Preparing ${fileName} (${inputStat.size.toLocaleString()} bytes)`);
  console.log(`Workdir: ${workdir}`);

  const chunkSize = Math.floor(opts.chunkSizeMiB * MIB);
  const estimatedChunks = Math.ceil(inputStat.size / chunkSize);
  const generatedStaticFileCount = estimatedChunks + 4; // chunks + index.html + app.js + styles.css + manifest.json
  if (generatedStaticFileCount > TEMPORARY_STATIC_ASSET_FILE_LIMIT) {
    throw new Error(
      `Temporary preview accounts allow up to ${TEMPORARY_STATIC_ASSET_FILE_LIMIT} static asset files. ` +
      `This input would generate about ${generatedStaticFileCount} files (${estimatedChunks} chunks + 4 UI/manifest files). ` +
      `Use a smaller file, claim/use a normal Cloudflare account, or switch storage to R2.`
    );
  }
  const { chunks, fileSha256 } = await splitFile(inputPath, publicDir, chunkSize);
  const mime = lookupMime(fileName) || 'application/octet-stream';
  const manifest: Manifest = {
    version: 1,
    fileName,
    size: inputStat.size,
    mime: String(mime),
    sha256: fileSha256,
    chunkSize,
    createdAt: new Date().toISOString(),
    suggestedParallelism: opts.parallel,
    chunks,
  };

  await writeFile(join(publicDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(publicDir, 'index.html'), indexHtml());
  await writeFile(join(publicDir, 'app.js'), appJs());
  await writeFile(join(publicDir, 'styles.css'), stylesCss());
  await mkdir(join(workdir, 'src'), { recursive: true });
  await writeFile(join(workdir, 'src', 'index.ts'), workerTs());
  await writeFile(join(workdir, 'wrangler.jsonc'), JSON.stringify({
    name: workerName,
    main: 'src/index.ts',
    compatibility_date: new Date().toISOString().slice(0, 10),
    assets: { directory: './public', binding: 'ASSETS' }
  }, null, 2));
  await writeFile(join(workdir, 'package.json'), JSON.stringify({
    type: 'module',
    private: true,
    scripts: { deploy: 'wrangler deploy --temporary', dev: 'wrangler dev' },
    dependencies: { hono: '^4.10.7' },
    devDependencies: { wrangler: '^4.56.1', typescript: '^5.9.3' }
  }, null, 2));

  console.log(`Wrote ${chunks.length} chunk(s), manifest, Hono Worker, and static UI.`);
  console.log(`File SHA-256: ${fileSha256}`);

  if (opts.noDeploy) {
    console.log('\nGenerated only. To preview/deploy:');
    console.log(`  cd ${workdir}`);
    console.log('  npm install');
    console.log('  npm run dev');
    console.log('  npm run deploy');
    return;
  }

  console.log('\nInstalling generated Worker dependencies...');
  await run('npm', ['install'], workdir);
  console.log('\nDeploying with wrangler deploy --temporary...');
  await mkdir(join(workdir, '.wrangler-temporary-home'), { recursive: true });
  await run('npx', ['wrangler', 'deploy', '--temporary'], workdir, temporaryWranglerEnv(workdir));

  if (!opts.keep && !opts.out) {
    console.log(`\nGenerated project kept at ${workdir} for inspection during this shell session.`);
  }
}

function workerTs(): string {
  return `import { Hono } from 'hono';

type Env = { ASSETS: Fetcher };
type Manifest = {
  fileName: string;
  size: number;
  mime: string;
  chunkSize: number;
  chunks: Array<{ index: number; path: string; size: number; sha256: string }>;
};

const app = new Hono<{ Bindings: Env }>();

async function loadManifest(assets: Fetcher, requestUrl: string): Promise<Manifest> {
  const url = new URL('/manifest.json', requestUrl);
  const res = await assets.fetch(new Request(url.toString()));
  if (!res.ok) throw new Error('manifest.json is missing');
  return await res.json();
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\\d*)-(\\d*)$/.exec(header.trim());
  if (!match) return null;
  let start: number;
  let end: number;
  if (match[1] === '' && match[2] === '') return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function streamByteRange(assets: Fetcher, requestUrl: string, manifest: Manifest, start: number, end: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const first = Math.floor(start / manifest.chunkSize);
        const last = Math.floor(end / manifest.chunkSize);
        for (let i = first; i <= last; i++) {
          const chunk = manifest.chunks[i];
          if (!chunk) throw new Error(\`missing chunk \${i}\`);
          const url = new URL(chunk.path, requestUrl);
          const res = await assets.fetch(new Request(url.toString()));
          if (!res.ok) throw new Error(\`chunk \${i} returned HTTP \${res.status}\`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          const localStart = i === first ? start - i * manifest.chunkSize : 0;
          const localEnd = i === last ? end - i * manifest.chunkSize + 1 : bytes.byteLength;
          controller.enqueue(bytes.slice(localStart, localEnd));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    }
  });
}

app.get('/api/manifest', async (c) => {
  const url = new URL('/manifest.json', c.req.url);
  const res = await c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-store');
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(res.body, { status: res.status, headers });
});

app.on('HEAD', '/file', async (c) => {
  const manifest = await loadManifest(c.env.ASSETS, c.req.url);
  return new Response(null, {
    status: 200,
    headers: {
      'accept-ranges': 'bytes',
      'content-type': manifest.mime || 'application/octet-stream',
      'content-length': String(manifest.size),
      'content-disposition': \`inline; filename*=UTF-8''\${encodeURIComponent(manifest.fileName)}\`,
      'cache-control': 'public, max-age=31536000, immutable',
    }
  });
});

app.get('/file', async (c) => {
  const manifest = await loadManifest(c.env.ASSETS, c.req.url);
  const baseHeaders = new Headers({
    'accept-ranges': 'bytes',
    'content-type': manifest.mime || 'application/octet-stream',
    'content-disposition': \`inline; filename*=UTF-8''\${encodeURIComponent(manifest.fileName)}\`,
    'cache-control': 'public, max-age=31536000, immutable',
  });
  const rangeHeader = c.req.header('range');
  if (!rangeHeader) {
    baseHeaders.set('content-length', String(manifest.size));
    return new Response(streamByteRange(c.env.ASSETS, c.req.url, manifest, 0, manifest.size - 1), { status: 200, headers: baseHeaders });
  }
  const range = parseRange(rangeHeader, manifest.size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': \`bytes */\${manifest.size}\`, 'accept-ranges': 'bytes' }
    });
  }
  baseHeaders.set('content-range', \`bytes \${range.start}-\${range.end}/\${manifest.size}\`);
  baseHeaders.set('content-length', String(range.end - range.start + 1));
  return new Response(streamByteRange(c.env.ASSETS, c.req.url, manifest, range.start, range.end), { status: 206, headers: baseHeaders });
});

app.get('/healthz', (c) => c.json({ ok: true }));

app.get('*', async (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
`;
}

function indexHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <title>Temporary file drop — waybill</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="page">
    <header class="masthead">
      <div class="mast-brand">
        <span class="mast-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none"><path d="M3 7l9-4 9 4-9 4-9-4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 7v10l9 4 9-4V7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 11v10" stroke="currentColor" stroke-width="1.8"/></svg>
        </span>
        <span class="mast-name">cf-temp-dropper</span>
      </div>
      <div class="mast-meta">
        <span class="mast-label">Waybill №</span>
        <span class="mast-id mono" id="waybill-id">—</span>
      </div>
    </header>

    <article class="waybill">
      <div class="waybill-stamp" aria-hidden="true">
        <span>Temporary</span>
        <span class="stamp-sub">expires ~60 min</span>
      </div>

      <section class="wb-header">
        <div class="wb-icon" id="ficon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
        </div>
        <div class="wb-title-block">
          <p class="wb-eyebrow" id="eyebrow">Loading</p>
          <h1 id="title">Temporary file</h1>
          <p id="meta" class="wb-sub">Reading manifest…</p>
          <p id="expires" class="expires">Temporary link · expires in about 60 minutes.</p>
        </div>
      </section>

      <dl class="wb-stats" aria-label="File details">
        <div><dt>Size</dt><dd id="stat-size">—</dd></div>
        <div><dt>Type</dt><dd id="stat-type" class="mono">—</dd></div>
      </dl>

      <section class="progress" aria-label="Download progress">
        <div class="progress-head">
          <span class="progress-label" id="progress-label">Waiting</span>
          <span class="progress-percent mono" id="progress-percent">0%</span>
        </div>
        <div class="track"><div class="fill" id="progress-fill" style="width:0%"></div></div>
        <div class="chunkgrid" id="chunkgrid" role="img" aria-label="Per-chunk status"></div>
        <div class="legend" id="legend" hidden>
          <span><i class="sw sw-done"></i> downloaded <b id="count-done">0</b></span>
          <span><i class="sw sw-cached"></i> resumed <b id="count-cached">0</b></span>
          <span><i class="sw sw-pending"></i> pending <b id="count-pending">0</b></span>
        </div>
      </section>

      <div class="preview" id="preview" aria-live="polite">
        <div class="preview-empty" id="preview-empty">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 8 7 4-7 4z" fill="currentColor"/><rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.6"/></svg>
          <span>Media preview appears here when available.</span>
        </div>
      </div>

      <div class="actions">
        <button id="download" class="btn btn-primary" disabled>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v10m0 0 3.5-3.5M12 14l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 18h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          <span id="download-label">Save verified copy</span>
        </button>
        <button id="clear" class="btn btn-ghost" disabled>Clear local cache</button>
      </div>

      <p id="status" class="status" role="status">Waiting for file manifest…</p>

      <div class="verify" aria-label="Integrity">
        <div class="verify-row">
          <span class="verify-label">SHA-256</span>
          <code class="verify-hash mono" id="sha">—</code>
          <button class="copy" id="copy-sha" type="button" disabled aria-label="Copy SHA-256">Copy</button>
        </div>
        <p class="verify-note">Use this hash to confirm the saved file matches.</p>
      </div>

      <details class="manifest">
        <summary>Full manifest</summary>
        <pre id="manifest" class="mono"></pre>
      </details>

    </article>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
}

function stylesCss(): string {
  return `:root {
  color-scheme: dark;
  --deep: #0a1e26;
  --deep-2: #0d2530;
  --surface: #113040;
  --surface-2: #163a4d;
  --surface-3: #1a4459;
  --amber: #f0a020;
  --amber-bright: #ffb830;
  --amber-dim: rgba(240, 160, 32, .15);
  --signal: #2dd4bf;
  --pass: #4ade80;
  --fail: #f87171;
  --text: #e8f0f2;
  --muted: #8ba5ad;
  --faint: #5a7278;
  --line: rgba(240, 160, 32, .10);
  --line-2: rgba(255, 255, 255, .06);
  --line-strong: rgba(240, 160, 32, .22);
  --font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: var(--font);
  color: var(--text);
  background:
    radial-gradient(900px 400px at 50% -5%, rgba(240, 160, 32, .06), transparent 60%),
    linear-gradient(180deg, var(--deep-2), var(--deep) 50%);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.mono { font-family: var(--mono); font-variant-ligatures: none; }

.page { width: min(780px, 100%); margin: 0 auto; padding: clamp(16px, 4vw, 48px) clamp(14px, 4vw, 24px) 40px; }

/* Masthead — shipping label header */
.masthead {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
  padding-bottom: 14px; margin-bottom: 0;
  border-bottom: 2px solid var(--amber);
  position: relative;
}
.masthead::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -5px;
  height: 1px; background: var(--amber); opacity: .3;
}
.mast-brand { display: inline-flex; align-items: center; gap: 10px; }
.mast-glyph { display: grid; place-items: center; width: 28px; height: 28px; color: var(--amber); }
.mast-glyph svg { width: 22px; height: 22px; }
.mast-name { font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: .08em; color: var(--text); text-transform: uppercase; }
.mast-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.mast-label { font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: .18em; color: var(--amber); text-transform: uppercase; }
.mast-id { font-size: 12px; color: var(--muted); }

/* Waybill document */
.waybill {
  --pad-x: clamp(18px, 4vw, 30px);
  position: relative;
  background: linear-gradient(180deg, var(--surface), var(--deep-2));
  border: 1px solid var(--line-strong);
  border-top: none;
  padding: clamp(20px, 4vw, 32px) var(--pad-x) 0;
  box-shadow: 0 20px 50px -24px rgba(0,0,0,.6);
  overflow: hidden;
}

/* TEMPORARY stamp */
.waybill-stamp {
  position: absolute; top: 12px; right: -24px;
  transform: rotate(8deg);
  display: flex; flex-direction: column; align-items: center;
  padding: 5px 32px;
  border: 2px solid var(--amber);
  color: var(--amber);
  font-family: var(--mono); font-weight: 700;
  font-size: 11px; letter-spacing: .15em;
  text-transform: uppercase;
  opacity: .5;
  pointer-events: none;
}
.stamp-sub { font-size: 8px; letter-spacing: .1em; margin-top: 1px; opacity: .8; }

/* Waybill header */
.wb-header { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 4px; }
.wb-icon { flex: none; display: grid; place-items: center; width: 48px; height: 48px; border: 1px solid var(--line-strong); color: var(--amber); background: var(--amber-dim); }
.wb-icon svg { width: 24px; height: 24px; }
.wb-title-block { min-width: 0; flex: 1; }
.wb-eyebrow { margin: 0 0 4px; font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: var(--amber); }
h1 { margin: 0; font-family: var(--mono); font-size: clamp(18px, 3.5vw, 24px); line-height: 1.2; font-weight: 700; letter-spacing: -.01em; overflow-wrap: anywhere; }
.wb-sub { margin: 8px 0 0; color: var(--muted); font-size: 13.5px; line-height: 1.55; }
.expires { margin: 10px 0 0; display: inline-flex; padding: 6px 9px; border: 1px solid var(--line-strong); background: rgba(240,160,32,.08); color: var(--amber-bright); font-family: var(--mono); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }

/* Stats grid — waybill fields */
.wb-stats { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 1px; margin: 24px 0; background: var(--line-2); border: 1px solid var(--line-2); }
.wb-stats div { min-width: 0; padding: 12px 14px; background: var(--surface-2); }
.wb-stats dt { margin: 0; font-family: var(--mono); color: var(--faint); font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; }
.wb-stats dd { margin: 5px 0 0; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-stats dd.mono { font-size: 12px; font-weight: 500; color: var(--muted); }

/* Progress section */
.progress { margin: 0 0 20px; }
.progress-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.progress-label { font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--text); }
.progress-percent { font-size: 13px; color: var(--amber); font-weight: 600; }
.track { height: 6px; background: var(--surface-3); border: 1px solid var(--line-2); overflow: hidden; }
.fill { height: 100%; width: 0; background: var(--amber); transition: width .35s cubic-bezier(.4,0,.2,1); }
.is-done .fill { background: var(--pass); }
.is-error .fill { background: var(--fail); }

/* Chunk grid — stowage plan */
.chunkgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(0, 1fr)); gap: 2px; margin-top: 12px; }
.chunkgrid.condensed { display: none; }
.cell { aspect-ratio: 1.8 / 1; background: var(--surface-3); border: 1px solid var(--line-2); transition: background .2s ease, border-color .2s ease; }
.cell.pending { background: var(--surface-3); }
.cell.cached { background: rgba(45, 212, 191, .25); border-color: rgba(45, 212, 191, .3); }
.cell.active { background: var(--amber); border-color: var(--amber-bright); animation: pulse 1s ease-in-out infinite; }
.cell.done { background: rgba(74, 222, 128, .3); border-color: rgba(74, 222, 128, .35); }
.cell.error { background: var(--fail); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

/* Legend */
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 10px; font-family: var(--mono); font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend b { color: var(--text); font-variant-numeric: tabular-nums; font-weight: 700; }
.sw { width: 10px; height: 6px; }
.sw-done { background: rgba(74, 222, 128, .5); border: 1px solid rgba(74, 222, 128, .4); }
.sw-cached { background: rgba(45, 212, 191, .4); border: 1px solid rgba(45, 212, 191, .3); }
.sw-pending { background: var(--surface-3); border: 1px solid var(--line-2); }

/* Preview — viewing bay */
.preview { margin: 0 0 20px; }
.preview-empty { display: flex; align-items: center; gap: 12px; padding: 20px; border: 1px dashed var(--line-strong); color: var(--faint); font-size: 13px; background: rgba(240, 160, 32, .02); }
.preview-empty svg { flex: none; width: 28px; height: 28px; opacity: .6; color: var(--amber); }
.preview-media { display: block; width: 100%; max-height: 55vh; object-fit: contain; border: 1px solid var(--line-2); background: #000; }
.preview video.preview-media { background: #000; }
.preview audio { width: 100%; }
.preview-file { display: flex; align-items: center; gap: 12px; padding: 16px; border: 1px solid var(--line-2); background: var(--surface-2); }
.preview-file svg { flex: none; width: 26px; height: 26px; color: var(--amber); }
.preview-file b { display: block; font-weight: 600; overflow-wrap: anywhere; }
.preview-file span { display: block; margin-top: 2px; color: var(--muted); font-size: 12.5px; }

/* Actions */
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 18px; border: 1px solid transparent; font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; cursor: pointer; transition: background .15s ease, border-color .15s ease, transform .1s ease, opacity .15s ease; }
.btn svg { width: 16px; height: 16px; }
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.btn-primary { flex: 1 1 auto; color: var(--deep); background: var(--amber); border-color: var(--amber-bright); }
.btn-primary:hover:not(:disabled) { background: var(--amber-bright); }
.btn-ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
.btn-ghost:hover:not(:disabled) { background: var(--amber-dim); border-color: var(--amber); }

/* Status line */
.status { min-height: 20px; margin: 0 0 20px; color: var(--muted); font-size: 13px; line-height: 1.5; font-family: var(--mono); }

/* Verify — seal box */
.verify { padding: 14px 16px; border: 1px solid var(--line-strong); background: var(--surface-2); position: relative; }
.verify::before { content: "SEAL"; position: absolute; top: -1px; left: 12px; transform: translateY(-50%); background: var(--deep-2); padding: 0 8px; font-family: var(--mono); font-size: 9px; font-weight: 700; letter-spacing: .2em; color: var(--amber); }
.verify-row { display: flex; align-items: center; gap: 10px; }
.verify-label { flex: none; font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.verify-hash { flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copy { flex: none; padding: 5px 10px; border: 1px solid var(--line-strong); background: transparent; color: var(--text); font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; cursor: pointer; transition: background .15s ease; }
.copy:hover:not(:disabled) { background: var(--amber-dim); }
.copy:disabled { opacity: .4; cursor: not-allowed; }
.verify-note { margin: 10px 0 0; color: var(--faint); font-size: 12px; line-height: 1.5; }

/* Manifest details */
.manifest { margin-top: 16px; }
summary { cursor: pointer; color: var(--muted); font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; list-style: none; padding: 4px 0; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "▸"; display: inline-block; margin-right: 8px; color: var(--amber); transition: transform .15s ease; }
.manifest[open] summary::before { transform: rotate(90deg); }
pre { margin: 10px 0 0; overflow: auto; max-height: 280px; padding: 14px; background: var(--deep); border: 1px solid var(--line-2); color: var(--muted); font-size: 12px; line-height: 1.5; }

@media (max-width: 560px) {
  .wb-stats { grid-template-columns: repeat(2, 1fr); }
  .btn-primary { flex-basis: 100%; }
  .btn-ghost { flex: 1 1 auto; }
}
@media (max-width: 480px) {
  .waybill-stamp { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .fill { transition: none; }
  .cell.active { animation: none; }
}
`;
}

function appJs(): string {
  return `const DB_NAME = 'cf-temp-dropper-v1';
const STORE = 'chunks';
const MAX_CELLS = 500;
const $ = (id) => document.getElementById(id);
let manifest;
let db;
let cells = [];
let counts = { done: 0, cached: 0, pending: 0 };

function formatBytes(n) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return \`\${v.toFixed(i ? 2 : 0)} \${units[i]}\`;
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function setStatus(text) { $('status').textContent = text; }

function isMedia(mime = manifest?.mime || '') {
  return mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/');
}

function setPhase(phase) {
  const box = document.querySelector('.progress');
  box.classList.toggle('is-done', phase === 'done');
  box.classList.toggle('is-error', phase === 'error');
  const labels = { idle: 'Ready', downloading: 'Downloading', verifying: 'Verifying', done: 'Complete', error: 'Failed' };
  $('progress-label').textContent = labels[phase] || 'Ready';
  $('legend').hidden = phase !== 'downloading';
}

function buildChunkGrid(total) {
  const grid = $('chunkgrid');
  grid.textContent = '';
  cells = [];
  if (total > MAX_CELLS) { grid.classList.add('condensed'); return; }
  const frag = document.createDocumentFragment();
  for (let i = 0; i < total; i++) {
    const cell = el('span', 'cell pending');
    cells.push(cell);
    frag.appendChild(cell);
  }
  grid.appendChild(frag);
}

function setCell(index, state) {
  const cell = cells[index];
  if (cell) cell.className = 'cell ' + state;
}

function renderProgress() {
  const total = manifest.chunks.length;
  const ready = counts.done + counts.cached;
  const pct = total ? Math.round((ready / total) * 100) : 100;
  $('progress-fill').style.width = pct + '%';
  $('progress-percent').textContent = pct + '%';
  $('count-done').textContent = counts.done;
  $('count-cached').textContent = counts.cached;
  $('count-pending').textContent = counts.pending;
}

function setIcon(mime) {
  const m = mime || '';
  let path;
  if (m.startsWith('image/')) path = '<rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="m4 18 5-5 4 4 3-3 4 4" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/>';
  else if (m.startsWith('video/')) path = '<rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="m10 9 5 3-5 3z" fill="currentColor"/>';
  else if (m.startsWith('audio/')) path = '<path d="M9 18V6l10-2v12" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none"/><circle cx="6.5" cy="18" r="2.5" stroke="currentColor" stroke-width="1.7" fill="none"/><circle cx="16.5" cy="16" r="2.5" stroke="currentColor" stroke-width="1.7" fill="none"/>';
  else path = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none"/>';
  $('ficon').innerHTML = '<svg viewBox="0 0 24 24" fill="none">' + path + '</svg>';
}

function resetPreview() {
  $('preview').innerHTML =
    '<div class="preview-empty" id="preview-empty">' +
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 8 7 4-7 4z" fill="currentColor"/><rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.6"/></svg>' +
    '<span>Media preview appears here when available. Verified download stays separate.</span></div>';
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode = 'readonly') {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function key(index) { return \`\${manifest.sha256}:\${index}\`; }

function idbGet(k) {
  return new Promise((resolve, reject) => {
    const req = tx().get(k);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(k, value) {
  return new Promise((resolve, reject) => {
    const req = tx('readwrite').put(value, k);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(k) {
  return new Promise((resolve, reject) => {
    const req = tx('readwrite').delete(k);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hasValidChunk(chunk) {
  const stored = await idbGet(key(chunk.index));
  return stored && stored.size === chunk.size && stored.sha256 === chunk.sha256;
}

async function fetchChunk(chunk) {
  if (await hasValidChunk(chunk)) return 'cached';
  const res = await fetch(chunk.path, { cache: 'force-cache' });
  if (!res.ok) throw new Error(\`Failed chunk \${chunk.index}: HTTP \${res.status}\`);
  const buffer = await res.arrayBuffer();
  const hash = await sha256Hex(buffer);
  if (hash !== chunk.sha256) throw new Error(\`Checksum mismatch in chunk \${chunk.index}\`);
  await idbPut(key(chunk.index), { size: buffer.byteLength, sha256: hash, buffer });
  return 'downloaded';
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  async function runner() {
    while (next < items.length) {
      await worker(items[next++]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
}

async function assembleBlob() {
  const parts = [];
  for (const chunk of manifest.chunks) {
    const stored = await idbGet(key(chunk.index));
    if (!stored) throw new Error(\`Missing chunk \${chunk.index}\`);
    parts.push(stored.buffer);
  }
  const blob = new Blob(parts, { type: manifest.mime || 'application/octet-stream' });
  const hash = await sha256Hex(await blob.arrayBuffer());
  if (hash !== manifest.sha256) throw new Error('Final checksum mismatch');
  return blob;
}

function renderStreamingPreview() {
  const mime = manifest.mime || '';
  if (!isMedia(mime)) { resetPreview(); return; }
  const box = $('preview');
  box.innerHTML = '';
  let media;
  if (mime.startsWith('image/')) {
    media = el('img', 'preview-media');
    media.alt = manifest.fileName;
    media.src = '/file';
  } else if (mime.startsWith('video/')) {
    media = el('video', 'preview-media');
    media.controls = true;
    media.playsInline = true;
    media.preload = 'metadata';
    media.src = '/file';
  } else if (mime.startsWith('audio/')) {
    media = el('audio');
    media.controls = true;
    media.preload = 'metadata';
    media.src = '/file';
  }
  box.append(media);
  const note = el('p', 'verify-note');
  note.textContent = 'Preview only — use “Save verified copy” for the full file.';
  box.append(note);
}

function renderVerifiedDownload(blob) {
  if (!isMedia()) {
    const box = $('preview');
    box.innerHTML = '';
    const card = el('div', 'preview-file');
    card.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    const info = el('div');
    const name = el('b');
    name.textContent = manifest.fileName;
    const size = el('span');
    size.textContent = formatBytes(manifest.size) + ' · ' + (manifest.mime || 'binary file');
    info.append(name, size);
    card.append(info);
    box.append(card);
  }
  const url = URL.createObjectURL(blob);
  const save = el('a', 'btn btn-ghost');
  save.href = url;
  save.download = manifest.fileName;
  save.textContent = 'Save verified file';
  save.style.marginTop = '12px';
  $('preview').append(save);
}

async function downloadResume() {
  $('download').disabled = true;
  $('clear').disabled = true;
  setPhase('downloading');
  try {
    counts = { done: 0, cached: 0, pending: 0 };
    const missing = [];
    for (const chunk of manifest.chunks) {
      if (await hasValidChunk(chunk)) { counts.cached++; setCell(chunk.index, 'cached'); }
      else { counts.pending++; setCell(chunk.index, 'pending'); missing.push(chunk); }
    }
    renderProgress();
    setStatus(missing.length
      ? \`Downloading \${missing.length} chunk\${missing.length === 1 ? '' : 's'}\${counts.cached ? \` · \${counts.cached} resumed from this browser\` : ''}…\`
      : 'All chunks already cached — verifying…');
    await runPool(missing, manifest.suggestedParallelism || 6, async (chunk) => {
      setCell(chunk.index, 'active');
      await fetchChunk(chunk);
      counts.done++;
      counts.pending--;
      setCell(chunk.index, 'done');
      renderProgress();
    });
    setPhase('verifying');
    setStatus('Verifying SHA-256…');
    const blob = await assembleBlob();
    setPhase('done');
    setStatus('Verified copy ready.');
    $('download-label').textContent = 'Prepare verified copy again';
    renderVerifiedDownload(blob);
  } catch (err) {
    setPhase('error');
    setStatus(err?.message || String(err));
    console.error(err);
  } finally {
    $('download').disabled = false;
    $('clear').disabled = false;
  }
}

async function clearCache() {
  $('clear').disabled = true;
  for (const chunk of manifest.chunks) await idbDelete(key(chunk.index));
  counts = { done: 0, cached: 0, pending: manifest.chunks.length };
  for (const chunk of manifest.chunks) setCell(chunk.index, 'pending');
  renderProgress();
  setPhase('idle');
  renderStreamingPreview();
  setStatus('Local cache cleared.');
  $('download-label').textContent = 'Save verified copy';
  $('clear').disabled = false;
}

async function copySha() {
  await navigator.clipboard.writeText(manifest.sha256);
  $('copy-sha').textContent = 'Copied';
  setTimeout(() => { $('copy-sha').textContent = 'Copy'; }, 1200);
}

function formatExpiry(iso) {
  const expires = new Date(new Date(iso).getTime() + 60 * 60 * 1000);
  return 'Temporary link · expires around ' + expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function init() {
  db = await openDb();
  const res = await fetch('/api/manifest', { cache: 'no-store' });
  manifest = await res.json();
  $('title').textContent = manifest.fileName;
  $('meta').textContent = isMedia(manifest.mime)
    ? \`Preview streams from the temporary Worker. Save a verified copy when you need the actual file.\`
    : \`Save a checksum-verified copy assembled from resumable Cloudflare Static Asset chunks.\`;
  $('eyebrow').textContent = manifest.mime?.startsWith('video/') ? 'Video file' : manifest.mime?.startsWith('audio/') ? 'Audio file' : manifest.mime?.startsWith('image/') ? 'Image file' : 'File drop';
  $('stat-size').textContent = formatBytes(manifest.size);
  $('stat-type').textContent = manifest.mime || 'application/octet-stream';
  $('expires').textContent = formatExpiry(manifest.createdAt);
  $('sha').textContent = manifest.sha256;
  $('waybill-id').textContent = manifest.sha256.slice(0, 12).toUpperCase();
  $('manifest').textContent = JSON.stringify(manifest, null, 2);
  setIcon(manifest.mime);
  renderStreamingPreview();
  buildChunkGrid(manifest.chunks.length);
  counts = { done: 0, cached: 0, pending: 0 };
  for (const chunk of manifest.chunks) {
    if (await hasValidChunk(chunk)) { counts.cached++; setCell(chunk.index, 'cached'); }
    else { counts.pending++; setCell(chunk.index, 'pending'); }
  }
  renderProgress();
  setPhase(counts.cached === manifest.chunks.length ? 'done' : 'idle');
  setStatus(counts.cached
    ? \`\${counts.cached}/\${manifest.chunks.length} chunks already cached in this browser.\`
    : isMedia(manifest.mime)
      ? 'Preview can stream now. Save a verified copy if you need the file.'
      : 'Ready. Save a verified copy; completed chunks resume after reload.');
  $('download').disabled = false;
  $('clear').disabled = false;
  $('copy-sha').disabled = false;
  $('download').addEventListener('click', downloadResume);
  $('clear').addEventListener('click', clearCache);
  $('copy-sha').addEventListener('click', copySha);
}

init().catch((err) => {
  $('status').textContent = err?.message || String(err);
  console.error(err);
});
`;
}

main().catch((err) => {
  console.error(`Error: ${err?.message ?? err}`);
  process.exit(1);
});
