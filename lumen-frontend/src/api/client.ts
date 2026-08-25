const TOKEN_STORAGE_KEY = 'lumen.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Thrown for every non-2xx response. Carries the exact backend error shape — never invented. */
export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The single place every API call goes through. Attaches Authorization automatically
 * when a token exists; never puts the token in a URL. All API modules (auth, books,
 * jobs, progress, characters, scenes) call this instead of using fetch directly, so
 * authentication and error handling are never duplicated per screen.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`/api${path}`, { ...init, headers });

  if (response.status === 204) {
    return undefined as T;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const errorBody = body as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      errorBody?.error?.code ?? 'UNKNOWN_ERROR',
      errorBody?.error?.message ?? 'Something went wrong.',
    );
  }

  return body as T;
}

/**
 * Dedicated binary-response fetch, used only for audio -- apiFetch() unconditionally
 * calls response.json(), which would fail against raw MP3/WAV/OGG bytes. This function
 * is deliberately parallel to apiFetch rather than a branch inside it: apiFetch is
 * depended on by every other screen, and audio is the one genuinely different response
 * shape in this whole API, so keeping it separate is lower-risk than adding a
 * conditional to the function everything else relies on.
 *
 * Preserves the exact same bearer-token attachment and safe-error behavior as apiFetch.
 */
export async function fetchAudioBlob(path: string): Promise<Blob> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`/api${path}`, { headers });

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON error body is unexpected here but still handled safely below.
    }
    const errorBody = body as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      errorBody?.error?.code ?? 'UNKNOWN_ERROR',
      errorBody?.error?.message ?? 'Could not load audio.',
    );
  }

  return response.blob();
}
