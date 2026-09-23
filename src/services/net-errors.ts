import { ScrapeFailure } from './scrape-failure';

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT',
]);

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : '';
}

function walk(err: unknown, visit: (current: unknown) => boolean): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (visit(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isTimeoutError(err: unknown): boolean {
  if (err instanceof ScrapeFailure) return err.reason === 'timeout';
  return walk(err, (current) => {
    if (current instanceof Error && (current.name === 'TimeoutError' || current.name === 'AbortError' || current.name === 'APIConnectionTimeoutError')) {
      return true;
    }
    const code = errorCode(current);
    if (code && TIMEOUT_CODES.has(code)) return true;
    return /net::ERR_TIMED_OUT|timed out|timeout/i.test(errorMessage(current));
  });
}

export function isRetryableTransport(err: unknown): boolean {
  if (err instanceof ScrapeFailure) return false;
  return walk(err, (current) => {
    const code = errorCode(current);
    if (code && RETRYABLE_CODES.has(code)) return true;
    if (
      current instanceof Error &&
      (current.name === 'AbortError' || current.name === 'APIConnectionError' || current.name === 'APIConnectionTimeoutError')
    ) {
      return true;
    }
    return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|UND_ERR_|other side closed|network socket|fetch failed/i.test(errorMessage(current));
  });
}

/** One Playwright retry for connection resets. Timeouts and challenges are not retried here. */
export function isRetryablePlaywright(err: unknown): boolean {
  if (err instanceof ScrapeFailure) return false;
  if (isTimeoutError(err)) return false;
  return walk(err, (current) => (
    /net::ERR_CONNECTION_RESET|net::ERR_NETWORK_CHANGED|net::ERR_ABORTED|net::ERR_CONNECTION_CLOSED|net::ERR_SOCKET_NOT_CONNECTED|net::ERR_CONNECTION_REFUSED|net::ERR_NAME_NOT_RESOLVED/i.test(errorMessage(current))
  ));
}
