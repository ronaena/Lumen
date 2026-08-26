import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IdentityContext, IdentityResolver } from '../identity/IdentityContext.js';
import { mapErrorToHttp, IDENTITY_UNAVAILABLE } from '../errors/mapErrorToHttp.js';
import { RateLimiter, type RateLimitConfig } from '../security/RateLimiter.js';

export interface ApiRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** null only on an explicitly public route (see RegisterOptions.public below). */
  identity: IdentityContext | null;
  /** Raw Authorization header, if present — needed by logout to derive the token to delete. */
  authorizationHeader: string | null;
  /**
   * The real client IP from the TCP socket (req.socket.remoteAddress) — never a
   * client-supplied header. No reverse proxy exists in this architecture (confirmed
   * during Workstream 13B discovery), so this is the authoritative client identity for
   * rate-limiting purposes. If a trusted proxy is ever introduced, this population point
   * is the one place that would need to change.
   */
  clientIp: string;
}

export interface ApiResponse {
  status: number;
  /** Buffer bodies are written raw (see ApiRouter.send()) -- everything else remains JSON, unchanged. */
  body: unknown;
  headers?: Record<string, string>;
}

export type RouteHandler = (req: ApiRequest) => Promise<ApiResponse>;

export interface RegisterOptions {
  /**
   * Explicit opt-out of the identity requirement — for register/login only, where a
   * session cannot exist yet by definition. Every other route remains identity-gated by
   * default; a route must deliberately declare itself public, never accidentally end up
   * that way.
   */
  public?: boolean;
  /**
   * Approved Workstream 13B mechanism: an explicit, per-route rate limit. `category`
   * must be unique per logical limit (not necessarily per route) so that, e.g., login
   * and registration never share a counter even though both key off the same client IP.
   */
  rateLimit?: RateLimitConfig & { category: string };
  /**
   * Voice Management v1 (approved workstream). Enforced in exactly one place (handle(),
   * right after identity resolution) -- never duplicated as an ad-hoc check inside any
   * individual handler, per the approved Decision Gate's explicit requirement. A route
   * with adminOnly: true is implicitly identity-gated too (adminOnly on a public route
   * makes no sense and is not a supported combination).
   */
  adminOnly?: boolean;
}

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
  public: boolean;
  rateLimit?: RateLimitConfig & { category: string };
  adminOnly: boolean;
}

function parsePath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function matchRoute(route: Route, method: string, pathSegments: string[]): Record<string, string> | null {
  if (route.method !== method) return null;
  if (route.segments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i += 1) {
    const routeSeg = route.segments[i]!;
    const pathSeg = pathSegments[i]!;
    if (routeSeg.startsWith(':')) {
      params[routeSeg.slice(1)] = decodeURIComponent(pathSeg);
    } else if (routeSeg !== pathSeg) {
      return null;
    }
  }
  return params;
}

function extractAuthorizationHeader(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? null;
}

/** 300 MiB — see Workstream 13C: comfortably above a 200MB EPUB's ~266MB base64 JSON representation. */
export const MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024;

type BodyReadResult = { tooLarge: true } | { tooLarge: false; body: unknown };

/**
 * Reads the request body while enforcing `maxBytes` DURING streaming — not after.
 *
 * The byte count is accumulated from each chunk's actual `byteLength` (real bytes off
 * the wire, never a JS string length, which could differ for multi-byte UTF-8 content).
 * The moment the running total exceeds the limit, no further chunk is added to the
 * in-memory `chunks` array — so `Buffer.concat()` and `JSON.parse()` never run against
 * the full oversized payload, and memory never grows past a small rolling window. This
 * is what makes the protection real rather than cosmetic: a check performed only after
 * collecting everything would have already paid the memory cost this feature exists to
 * avoid. (The stream is still drained to completion rather than the connection being
 * torn down mid-transfer — see the comment inside the loop for why.)
 *
 * This also transparently covers chunked-transfer-encoding requests: Content-Length is
 * never consulted at all (a client-controlled, spoofable header) — only the actual bytes
 * observed on the stream are counted, so there's no way to under-report size via a
 * mismatched or absent Content-Length.
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyReadResult> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let exceeded = false;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    totalBytes += buf.byteLength;
    if (totalBytes > maxBytes) {
      // Once exceeded, stop accumulating (the actual memory-safety property this
      // feature exists for) but deliberately do NOT `return`/`break` out of this loop.
      // Node's `for await...of` over a Readable stream calls the stream's internal
      // destroy() as part of early-exit cleanup — and since req/res share one
      // underlying socket, that destroy tears down the connection before a response
      // can ever be written back (a real bug caught by an actual test: the client
      // observed a bare connection reset instead of a proper 413). Draining the
      // iterator to its natural end instead avoids that, while still never letting the
      // discarded chunks accumulate — memory stays bounded either way.
      exceeded = true;
      continue;
    }
    chunks.push(buf);
  }

  if (exceeded) return { tooLarge: true };
  if (chunks.length === 0) return { tooLarge: false, body: undefined };
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) return { tooLarge: false, body: undefined };
  try {
    return { tooLarge: false, body: JSON.parse(raw) };
  } catch {
    return { tooLarge: false, body: { __unparseable: true, raw } };
  }
}

/**
 * ApiRouter — the entire HTTP boundary.
 *
 * Every route is identity-gated by DEFAULT (Phase 12 behavior, unchanged). Workstream
 * 13B adds one more optional, explicit, per-route opt-in: `rateLimit`. Routes that don't
 * specify it are completely unaffected — this is additive, not a behavior change to any
 * existing route.
 *
 * Rate limiting is checked immediately after route matching, before identity resolution
 * or body parsing — this protects public routes (login/register, which have no identity
 * to resolve) and avoids doing any other work for a request that's about to be rejected.
 */
export class ApiRouter {
  private readonly routes: Route[] = [];

  constructor(
    private readonly identityResolver: IdentityResolver,
    private readonly rateLimiter: RateLimiter = new RateLimiter(),
    /**
     * Remote Deployment v1 (approved workstream). Optional -- when a request matches no
     * registered API route, this is tried before the generic 404. Used in production to
     * serve the frontend's static build (and its client-side routes) from the same
     * process/port as the API, so a single-service deployment needs no CORS/second-origin
     * configuration. Absent in every existing test file and in dev mode (where Vite's own
     * dev server handles static assets) -- zero effect on any existing caller.
     */
    private readonly notFoundFallback?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  ) {}

  register(method: string, path: string, handler: RouteHandler, options: RegisterOptions = {}): void {
    this.routes.push({
      method: method.toUpperCase(),
      segments: parsePath(path),
      handler,
      public: options.public ?? false,
      rateLimit: options.rateLimit,
      adminOnly: options.adminOnly ?? false,
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://internal');
      const pathSegments = parsePath(url.pathname);
      const method = (req.method ?? 'GET').toUpperCase();
      /**
       * Remote Deployment v1: when a static-file fallback is configured (combined
       * single-service production mode), route matching only ever considers paths
       * actually prefixed with "/api/" -- the prefix is stripped before matching. Any
       * bare path (no "/api" prefix) skips route matching entirely and goes straight to
       * the fallback.
       *
       * This distinction matters because without it, a bare path like /books/abc-123 —
       * which in production is a real BROWSER deep-link into the frontend's own
       * client-side route, since apiFetch() always uses the /api/ prefix and no genuine
       * API caller ever omits it — would otherwise collide with the real backend route
       * GET /books/:bookId and be incorrectly treated as an (unauthenticated, 401) API
       * call instead of falling through to the SPA's index.html. Found and fixed via
       * real end-to-end testing of the combined-serving mode, not assumed safe.
       *
       * When no fallback is configured (dev mode, every existing test), this branch
       * never applies -- bare paths match routes exactly as they always have, byte for
       * byte the same behavior as before this workstream.
       *
       * REAL DEFECT found and fixed via direct process verification of combined mode
       * (not assumed safe from code review alone): GET /health and GET /ready are
       * themselves bare, non-"/api"-prefixed routes -- by the same logic above, they
       * were being swallowed by the SPA fallback and returning index.html instead of
       * their real JSON status. This breaks real deployment health checks, since every
       * common hosting platform's liveness/readiness probe hits the bare, unprefixed
       * path by convention, not an app-specific API namespace. Fixed with a narrow,
       * explicit exception for exactly these two well-known operational paths -- they
       * still route normally even in combined mode, before the fallback is ever tried.
       */
      const isBareHealthCheckPath =
        method === 'GET' && pathSegments.length === 1 && (pathSegments[0] === 'health' || pathSegments[0] === 'ready');

      let effectiveSegments = pathSegments;
      if (this.notFoundFallback && !isBareHealthCheckPath) {
        if (pathSegments[0] === 'api') {
          effectiveSegments = pathSegments.slice(1);
        } else {
          const handled = await this.notFoundFallback(req, res);
          if (handled) return;
          this.send(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'No matching route.' } });
          return;
        }
      }

      const clientIp = req.socket.remoteAddress ?? 'unknown';

      const matchedRoute = this.routes.find((route) => matchRoute(route, method, effectiveSegments) !== null);
      if (!matchedRoute) {
        // notFoundFallback was already tried above for combined mode's bare-path case;
        // an /api/-prefixed miss that still matched nothing is a genuine API 404.
        if (this.notFoundFallback && (await this.notFoundFallback(req, res))) {
          return;
        }
        this.send(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'No matching route.' } });
        return;
      }
      const params = matchRoute(matchedRoute, method, effectiveSegments)!;

      if (matchedRoute.rateLimit) {
        // Fail-open: if the limiter itself throws unexpectedly, the request proceeds
        // rather than the API going down over a hardening layer. No logging framework
        // exists in this project (confirmed during 13B discovery), so this failure mode
        // is silent by design rather than introducing a new, unestablished logging
        // pattern into production request handling.
        let limitResult: { allowed: boolean; retryAfterSeconds: number } = { allowed: true, retryAfterSeconds: 0 };
        try {
          const key = `${clientIp}:${matchedRoute.rateLimit.category}`;
          limitResult = this.rateLimiter.check(key, matchedRoute.rateLimit);
        } catch {
          limitResult = { allowed: true, retryAfterSeconds: 0 };
        }
        if (!limitResult.allowed) {
          this.send(
            res,
            429,
            { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } },
            { 'Retry-After': String(limitResult.retryAfterSeconds) },
          );
          return;
        }
      }

      // Body is read (with the streaming size limit enforced) BEFORE identity
      // resolution — this is the Workstream 13C requirement that the body-size defense
      // applies ahead of authentication logic, not after paying for a DB session lookup
      // first. Malformed-JSON detection also now happens before the identity check as a
      // direct consequence of this reordering; this was verified against the full
      // regression suite rather than assumed safe.
      const bodyResult =
        method === 'GET' || method === 'DELETE'
          ? ({ tooLarge: false, body: undefined } as const)
          : await readBody(req, MAX_REQUEST_BODY_BYTES);

      if (bodyResult.tooLarge) {
        this.send(res, 413, {
          error: { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the maximum allowed size.' },
        });
        return;
      }
      const body = bodyResult.body;
      if (body && typeof body === 'object' && '__unparseable' in body) {
        this.send(res, 400, { error: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON.' } });
        return;
      }

      let identity: IdentityContext | null = null;
      if (!matchedRoute.public) {
        identity = await this.identityResolver({ headers: req.headers });
        if (!identity) {
          this.send(res, IDENTITY_UNAVAILABLE.status, IDENTITY_UNAVAILABLE.body);
          return;
        }
      }

      if (matchedRoute.adminOnly && identity?.role !== 'admin') {
        // Deliberately the same 403 shape as every other authorization-style rejection
        // in this codebase (mapErrorToHttp's existing conventions) -- not a new error
        // architecture. Unauthenticated already returned 401 above; this is specifically
        // "authenticated, but not an admin."
        this.send(res, 403, {
          error: { code: 'FORBIDDEN', message: 'This action requires administrator access.' },
        });
        return;
      }

      const apiRequest: ApiRequest = {
        params,
        query: url.searchParams,
        body,
        identity,
        authorizationHeader: extractAuthorizationHeader(req.headers),
        clientIp,
      };
      const result = await matchedRoute.handler(apiRequest);
      this.send(res, result.status, result.body, result.headers);
    } catch (error) {
      const mapped = mapErrorToHttp(error);
      this.send(res, mapped.status, mapped.body);
    }
  }

  /** Exposed for the production server to start/stop the limiter's cleanup sweep. */
  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  /**
   * Binary bodies (Buffer) are written raw with the caller-supplied Content-Type header
   * -- added for Gap 2 (audio delivery). Everything else takes the pre-existing JSON
   * path, completely unchanged: this is a branch, not a rewrite of send().
   */
  private send(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
    if (Buffer.isBuffer(body)) {
      res.writeHead(status, { ...headers });
      res.end(body);
      return;
    }
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(json);
  }
}
