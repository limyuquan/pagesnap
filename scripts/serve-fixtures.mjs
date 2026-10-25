#!/usr/bin/env node
/**
 * Tiny static server for tests/fixtures/pages (used by Playwright's webServer and for manual
 * checks). No dependencies, no caching.
 *
 *   node scripts/serve-fixtures.mjs            # http://127.0.0.1:4321/bands.html
 *   FIXTURE_PORT=5000 node scripts/serve-fixtures.mjs
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../tests/fixtures/pages', import.meta.url)));
const port = Number(process.env.FIXTURE_PORT ?? 4321);
const host = process.env.FIXTURE_HOST ?? '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://x');
  if (pathname === '/') {
    const files = (await readdir(root)).filter((f) => f.endsWith('.html')).sort();
    res.writeHead(200, { 'content-type': types['.html'], 'cache-control': 'no-store' });
    res.end(files.map((f) => `<p><a href="/${f}">${f}</a></p>`).join('\n'));
    return;
  }
  const file = normalize(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`fixtures: http://${host}:${port}/`);
});
