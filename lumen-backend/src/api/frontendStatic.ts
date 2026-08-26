import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

/**
 * Remote Deployment v1 (approved workstream). Serves the frontend's built static files
 * from the same process/port as the API, so a single-service host (the smallest viable
 * shape for a phone-only, free-tier deployment) needs no second origin/CORS setup.
 *
 * This is deliberately NOT a general-purpose static file server -- it exists only to
 * serve one known, trusted directory (the frontend's own `vite build` output), never
 * user-supplied paths. Path traversal is blocked by construction: the resolved path is
 * verified to still be inside staticRoot before ever being read.
 *
 * SPA fallback: any GET request that doesn't match a real file under staticRoot (e.g.
 * a client-side route like /books/abc-123) serves index.html instead of 404ing, so
 * React Router's own client-side routing takes over -- exactly what a browser
 * navigating directly to a deep link needs.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function createFrontendStaticFallback(staticRoot: string) {
  return async function serveFrontendStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://internal');
    if (url.pathname.startsWith('/api/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const requestedPath = normalize(join(staticRoot, url.pathname));
    const isSafe = requestedPath === staticRoot || requestedPath.startsWith(staticRoot + '/');
    const candidatePath = isSafe ? requestedPath : staticRoot;

    const filePath = await resolveExistingFile(candidatePath, staticRoot);
    if (!filePath) return false;

    try {
      const body = await readFile(filePath);
      const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    } catch {
      return false;
    }
  };
}

async function resolveExistingFile(candidatePath: string, staticRoot: string): Promise<string | null> {
  try {
    const stats = await stat(candidatePath);
    if (stats.isFile()) return candidatePath;
  } catch {
    // Falls through to the SPA/index.html fallback below.
  }
  const indexPath = join(staticRoot, 'index.html');
  try {
    const stats = await stat(indexPath);
    if (stats.isFile()) return indexPath;
  } catch {
    // No frontend build present at all -- genuinely nothing to serve.
  }
  return null;
}
