export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m, 'bad_request');
export const unauthorized = (m = 'Unauthorized') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Forbidden') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');
export const gone = (m: string) => new HttpError(410, m, 'gone');
export const notImplemented = (m: string) => new HttpError(501, m, 'not_implemented');

/** 503 that tells clients to retry the same request (upstream hiccup, timeout, rate-limit). */
export class RetriableError extends HttpError {
  constructor(
    message: string,
    public retryAfter?: number,
    status = 503,
  ) {
    super(status, message, 'retriable');
  }
}

/**
 * Classify an upstream failure: network errors, timeouts, 408/425/429/5xx are retriable;
 * other 4xx are not. Returns the HTTP status (or 0 for network) and whether to retry.
 */
export function classifyUpstream(err: unknown): { retriable: boolean; status: number } {
  const e = err as { status?: number; name?: string; message?: string };
  if (err instanceof RetriableError) return { retriable: true, status: err.status };
  if (err instanceof HttpError) return { retriable: false, status: err.status };
  const status = typeof e?.status === 'number' ? e.status : 0;
  if (!status) return { retriable: true, status: 0 }; // TypeError: fetch failed, AbortError/TimeoutError, ECONNRESET...
  if (status === 408 || status === 425 || status === 429 || status >= 500) return { retriable: true, status };
  return { retriable: false, status };
}
