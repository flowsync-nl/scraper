import { ZodError } from 'zod';
import type { ChallengeVendor } from './fetch-classifier';

export type ScrapeCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'blocked'
  | 'upstream_unavailable'
  | 'timeout'
  | 'extractor_failed'
  | 'internal';

export type ScrapeReason =
  | 'bot_challenge'
  | 'http_forbidden'
  | 'rate_limited'
  | 'upstream_http'
  | 'network'
  | 'timeout'
  | 'model_unavailable'
  | 'extractor_parse'
  | 'parser_failed'
  | 'browser_unavailable'
  | 'unexpected';

export interface ScrapeTarget {
  url?: string;
  httpStatus?: number;
  vendor?: ChallengeVendor | null;
}

export interface ScrapeErrorBody {
  error: string;
  code: ScrapeCode;
  reason?: ScrapeReason;
  retryable: boolean;
  domain?: string;
  target?: {
    url?: string;
    httpStatus?: number;
    vendor: ChallengeVendor | null;
  };
}

export interface BlockLock {
  code: 'blocked';
  reason?: ScrapeReason;
  domain?: string;
  target?: ScrapeTarget;
}

export interface ScrapeFailureInit {
  code: ScrapeCode;
  reason?: ScrapeReason;
  retryable?: boolean;
  domain?: string;
  stage?: string;
  message?: string;
  target?: ScrapeTarget;
}

const PUBLIC_MESSAGE: Record<ScrapeCode, string> = {
  invalid_request: 'Invalid request',
  unauthorized: 'Unauthorized',
  blocked: 'Target blocked the scrape',
  upstream_unavailable: 'Target site unavailable',
  timeout: 'Scrape timed out',
  extractor_failed: 'Extractor failed',
  internal: 'Scrape failed',
};

function defaultRetryable(code: ScrapeCode, reason?: ScrapeReason): boolean {
  if (code === 'upstream_unavailable' || code === 'timeout') return true;
  if (code === 'extractor_failed') {
    return reason === 'rate_limited' || reason === 'network';
  }
  return false;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/ANTHROPIC_API_KEY\s*[=:]\s*\S+/gi, 'ANTHROPIC_API_KEY=[redacted]')
    .replace(/redis:\/\/\S+/gi, 'redis://[redacted]')
    .replace(/(api[_-]?key\s*[=:]\s*)\S+/gi, '$1[redacted]');
}

/** Log-safe text: no secrets, no HTML, no stacks. */
export function safeErrorMessage(input: unknown): string {
  const raw = input instanceof Error ? input.message : String(input ?? '');
  let text = redactSecrets(raw);
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const cut = text.indexOf('<');
  if (cut >= 0) text = text.slice(0, cut);
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return 'Scrape failed';
  return text.slice(0, 500);
}

export class ScrapeFailure extends Error {
  readonly code: ScrapeCode;
  readonly reason?: ScrapeReason;
  readonly retryable: boolean;
  readonly publicMessage: string;
  domain?: string;
  stage?: string;
  target?: ScrapeTarget;

  constructor(init: ScrapeFailureInit) {
    super(safeErrorMessage(init.message ?? PUBLIC_MESSAGE[init.code]));
    this.name = 'ScrapeFailure';
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = init.code;
    this.reason = init.reason;
    this.retryable = init.retryable ?? defaultRetryable(init.code, init.reason);
    this.publicMessage = PUBLIC_MESSAGE[init.code];
    this.domain = init.domain;
    this.stage = init.stage;
    this.target = init.target;
  }

  attachDomain(domain: string): this {
    if (!this.domain) this.domain = domain;
    return this;
  }

  httpStatus(): number {
    switch (this.code) {
      case 'invalid_request':
        return 400;
      case 'unauthorized':
        return 401;
      case 'blocked':
        return 422;
      case 'upstream_unavailable':
        return 502;
      case 'timeout':
        return 504;
      case 'extractor_failed':
        return 502;
      case 'internal':
        return 500;
    }
  }

  toBody(): ScrapeErrorBody {
    const body: ScrapeErrorBody = {
      error: this.publicMessage,
      code: this.code,
      retryable: this.retryable,
    };
    if (this.reason) body.reason = this.reason;
    if (this.domain) body.domain = this.domain;
    if (this.target && (this.target.url || this.target.httpStatus !== undefined)) {
      body.target = {
        vendor: this.target.vendor ?? null,
      };
      if (this.target.url) body.target.url = this.target.url;
      if (this.target.httpStatus !== undefined) body.target.httpStatus = this.target.httpStatus;
    }
    return body;
  }

  toLock(): BlockLock {
    return {
      code: 'blocked',
      reason: this.reason,
      domain: this.domain,
      target: this.target
        ? {
            url: this.target.url,
            httpStatus: this.target.httpStatus,
            vendor: this.target.vendor ?? null,
          }
        : undefined,
    };
  }

  static fromLock(lock: BlockLock, domain?: string): ScrapeFailure {
    return new ScrapeFailure({
      code: 'blocked',
      reason: lock.reason ?? 'bot_challenge',
      retryable: false,
      domain: lock.domain ?? domain,
      stage: 'cache',
      message: 'block lock hit',
      target: lock.target,
    });
  }
}

export function scrapeErrorResponse(error: unknown, domain?: string): { status: number; body: ScrapeErrorBody } {
  if (error instanceof ScrapeFailure) {
    if (domain) error.attachDomain(domain);
    return { status: error.httpStatus(), body: error.toBody() };
  }

  if (error instanceof ZodError) {
    const body: ScrapeErrorBody = {
      error: PUBLIC_MESSAGE.invalid_request,
      code: 'invalid_request',
      retryable: false,
    };
    if (domain) body.domain = domain;
    return { status: 400, body };
  }

  const body: ScrapeErrorBody = {
    error: PUBLIC_MESSAGE.internal,
    code: 'internal',
    reason: 'unexpected',
    retryable: false,
  };
  if (domain) body.domain = domain;
  return { status: 500, body };
}

export function scrapeLogFields(error: unknown, domain?: string): Record<string, unknown> {
  const failure = error instanceof ScrapeFailure ? error : null;
  const fields: Record<string, unknown> = {
    stage: failure?.stage ?? 'route',
    code: failure?.code ?? 'internal',
    err: {
      name: error instanceof Error ? error.name : 'Error',
      message: safeErrorMessage(error),
    },
  };
  const resolvedDomain = failure?.domain ?? domain;
  if (resolvedDomain) fields.domain = resolvedDomain;
  if (failure?.target?.url) fields.url = failure.target.url;
  if (typeof failure?.target?.httpStatus === 'number') fields.targetStatus = failure.target.httpStatus;
  if (failure?.target && (failure.target.vendor !== undefined || failure.target.url)) {
    fields.vendor = failure.target.vendor ?? null;
  }
  return fields;
}
