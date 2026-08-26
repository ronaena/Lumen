import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFrontendStaticFallback } from '../../src/api/frontendStatic.js';

describe('createFrontendStaticFallback (Remote Deployment v1)', () => {
  let staticRoot: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    staticRoot = await mkdtemp(join(tmpdir(), 'lumen-static-test-'));
    await writeFile(join(staticRoot, 'index.html'), '<html><body>Lumen SPA shell</body></html>');
    await mkdir(join(staticRoot, 'assets'));
    await writeFile(join(staticRoot, 'assets', 'app.js'), 'console.log("real js bundle");');

    const fallback = createFrontendStaticFallback(staticRoot);
    server = createServer(async (req, res) => {
      const handled = await fallback(req, res);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'ROUTE_NOT_FOUND' } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(staticRoot, { recursive: true, force: true });
  });

  it('serves a real existing static file with the correct content type', async () => {
    const response = await fetch(`${baseUrl}/assets/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/javascript');
    expect(await response.text()).toContain('real js bundle');
  });

  it('serves index.html at the root path', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Lumen SPA shell');
  });

  it('SPA fallback: a client-side route with no matching file still serves index.html, not a 404', async () => {
    const response = await fetch(`${baseUrl}/books/some-real-looking-uuid`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Lumen SPA shell');
  });

  it('an /api/-prefixed miss is NOT served as HTML -- stays a real 404 for API consumers', async () => {
    const response = await fetch(`${baseUrl}/api/totally-unknown-route`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('path traversal is blocked -- cannot escape staticRoot', async () => {
    const response = await fetch(`${baseUrl}/%2e%2e/%2e%2e/%2e%2e/etc/passwd`);
    const text = await response.text();
    expect(text).not.toMatch(/root:.*:0:0:/);
  });
});
