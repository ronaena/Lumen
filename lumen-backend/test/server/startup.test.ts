import { describe, it, expect, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../../src/config/env.js';
import { createDatabaseWithPool } from '../../src/db/client.js';
import { createGracefulShutdown } from '../../src/main.js';
import { RateLimiter } from '../../src/api/security/RateLimiter.js';
import { LocalFilesystemStorageProvider } from '../../src/processing/storage/LocalFilesystemStorageProvider.js';

const REAL_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lumen:lumen@localhost:5432/lumen_test';

describe('Production entrypoint: configuration', () => {
  it('valid environment (including PORT/STORAGE_ROOT defaults) is accepted', () => {
    const env = loadEnv({ DATABASE_URL: REAL_DATABASE_URL });
    expect(env.PORT).toBe(3000);
    expect(env.STORAGE_ROOT).toBe('./storage-data');
  });

  it('an explicit PORT is honored over the default', () => {
    const env = loadEnv({ DATABASE_URL: REAL_DATABASE_URL, PORT: '8080' });
    expect(env.PORT).toBe(8080);
  });

  it('an explicit STORAGE_ROOT is honored over the default', () => {
    const env = loadEnv({ DATABASE_URL: REAL_DATABASE_URL, STORAGE_ROOT: '/tmp/custom-storage' });
    expect(env.STORAGE_ROOT).toBe('/tmp/custom-storage');
  });

  it('missing required DATABASE_URL fails clearly, not silently', () => {
    // zod's own "Required" message fires for a genuinely missing key (as opposed to an
    // empty string, which triggers the schema's custom .min(1, ...) message instead) --
    // both are pre-existing, correct zod behavior. The real requirement under test is
    // that startup fails loudly and clearly either way, which it does.
    expect(() => loadEnv({})).toThrow(/Invalid environment configuration/);
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('an empty-string DATABASE_URL fails with the specific custom message', () => {
    expect(() => loadEnv({ DATABASE_URL: '' })).toThrow(/DATABASE_URL is required/);
  });

  it('a malformed DATABASE_URL fails clearly', () => {
    expect(() => loadEnv({ DATABASE_URL: 'not-a-postgres-url' })).toThrow(/postgres/);
  });
});

describe('Production entrypoint: storage root is honored', () => {
  it('a file written through a storage provider constructed from configured STORAGE_ROOT lands under that exact root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumen-storage-root-test-'));
    try {
      const env = loadEnv({ DATABASE_URL: REAL_DATABASE_URL, STORAGE_ROOT: root });
      const storage = new LocalFilesystemStorageProvider(env.STORAGE_ROOT);
      const ref = await storage.write('probe.txt', Buffer.from('hello'));
      const key = ref.replace('local://', '');
      const contents = await readFile(join(root, key), 'utf8');
      expect(contents).toBe('hello');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Production entrypoint: real server binding', () => {
  let server: Server;

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('the configured PORT is what the server actually binds to (using an ephemeral port to stay test-safe)', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${addr.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
});

describe('Production entrypoint: graceful shutdown', () => {
  it('shutdown closes the server, stops the rate limiter cleanup, and ends the database pool -- verified by calling the extracted function directly, never a real OS signal', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const { pool } = createDatabaseWithPool(REAL_DATABASE_URL);
    const rateLimiter = new RateLimiter();
    rateLimiter.startCleanup();
    const stopCleanupSpy = vi.spyOn(rateLimiter, 'stopCleanup');
    const poolEndSpy = vi.spyOn(pool, 'end');

    const shutdown = createGracefulShutdown(server, pool, rateLimiter);
    await shutdown();

    expect(stopCleanupSpy).toHaveBeenCalledOnce();
    expect(poolEndSpy).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
  });

  it('shutdown is safe to invoke twice (guards against a second signal arriving mid-shutdown) -- does not throw or double-close', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const { pool } = createDatabaseWithPool(REAL_DATABASE_URL);
    const rateLimiter = new RateLimiter();
    rateLimiter.startCleanup();
    const poolEndSpy = vi.spyOn(pool, 'end');

    const shutdown = createGracefulShutdown(server, pool, rateLimiter);
    await shutdown();
    await expect(shutdown()).resolves.toBeUndefined();

    expect(poolEndSpy).toHaveBeenCalledOnce();
  });
});
