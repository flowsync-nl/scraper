export type FetchKind = 'ok' | 'challenge' | 'not_found' | 'upstream_error' | 'transport_error';

export type ChallengeVendor = 'siteground' | 'cloudflare' | 'datadome' | 'perimeterx' | 'generic';

export type FetchReason =
  | 'bot_challenge'
  | 'http_forbidden'
  | 'rate_limited'
  | 'upstream_http'
  | 'network'
  | 'timeout';

export interface FetchClassification {
  kind: FetchKind;
  vendor: ChallengeVendor | null;
  reason?: FetchReason;
}

export const CAREER_PAGE_INDICATORS = [
  'vacancy',
  'vacancies',
  'vacature',
  'vacatures',
  'job opening',
  'job listings',
  'open position',
  'we are hiring',
  'join our team',
  'career',
  'werken bij',
  'kom werken',
] as const;

const THIN_TEXT = 400;
const SHORT_INTERSTITIAL = 800;

export function hasCareerSignals(value: string): boolean {
  const lower = value.toLowerCase();
  return CAREER_PAGE_INDICATORS.some((indicator) => lower.includes(indicator));
}

export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function headersToRecord(
  headers: Headers | Record<string, string | undefined> | undefined,
): Record<string, string> {
  if (!headers) return {};

  const asHeaders = headers as Headers;
  if (typeof asHeaders.forEach === 'function' && typeof asHeaders.get === 'function') {
    const out: Record<string, string> = {};
    asHeaders.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    const withCookies = asHeaders as Headers & { getSetCookie?: () => string[] };
    if (typeof withCookies.getSetCookie === 'function') {
      const cookies = withCookies.getSetCookie();
      if (cookies.length > 0) out['set-cookie'] = cookies.join('\n');
    }
    return out;
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, string | undefined>)) {
    if (value !== undefined) out[key.toLowerCase()] = value;
  }
  return out;
}

function pageTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

function scriptSrcs(html: string): string {
  return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((match) => match[1]).join('\n');
}

function elementIds(html: string): string {
  return [...html.matchAll(/\sid=["']([^"']+)["']/gi)].map((match) => match[1]).join('\n');
}

function headerBlob(headers: Record<string, string>): string {
  return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\n');
}

function looksLikeHtmlDocument(headers: Record<string, string>, html: string): boolean {
  const contentType = headers['content-type'] ?? '';
  if (/text\/html|application\/xhtml/i.test(contentType)) return true;
  if (/json|xml|plain/i.test(contentType)) return false;
  return /<\s*html[\s>]|<\s*!doctype\s+html/i.test(html);
}

function detectVendor(headers: Record<string, string>, html: string): ChallengeVendor | null {
  const headersText = headerBlob(headers);
  const title = pageTitle(html);
  const concentrated = [title, scriptSrcs(html), elementIds(html), headersText].join('\n');
  const anywhere = `${headersText}\n${html}`;

  if (/sgcaptcha|sg-captcha|sg-security/i.test(anywhere)) return 'siteground';
  if (/cf-mitigated|cf-challenge|cf-turnstile|challenge-platform/i.test(anywhere)) return 'cloudflare';
  if (/just a moment/i.test(title)) return 'cloudflare';
  if (/x-datadome|\bdd-cid\b/i.test(headersText) || /datadome|\bdd-cid\b/i.test(concentrated)) {
    return 'datadome';
  }
  if (/_pxhd|px-captcha/i.test(anywhere) || /perimeterx/i.test(concentrated)) return 'perimeterx';
  return null;
}

function reasonForStatus(status: number): FetchReason {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'http_forbidden';
  return 'bot_challenge';
}

function hasSubstantialCareerText(html: string): boolean {
  const text = visibleText(html);
  return text.length >= THIN_TEXT && hasCareerSignals(text);
}

/**
 * Classify a fetched document before it is treated as a career page or sent to a model.
 * Vendor markers win over career-looking substrings, including URLs echoed inside a challenge.
 */
export function classifyFetch(
  status: number,
  headers: Headers | Record<string, string | undefined> | undefined,
  html: string | null | undefined,
): FetchClassification {
  const normalized = headersToRecord(headers);
  const body = html ?? '';

  if (status === 0) {
    return { kind: 'transport_error', vendor: null, reason: 'network' };
  }

  const vendor = detectVendor(normalized, body);
  if (vendor) {
    return { kind: 'challenge', vendor, reason: reasonForStatus(status) };
  }

  if (status === 404 || status === 410) {
    return { kind: 'not_found', vendor: null };
  }

  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return { kind: 'upstream_error', vendor: null, reason: 'upstream_http' };
  }

  const htmlDoc = looksLikeHtmlDocument(normalized, body);
  const text = visibleText(body);

  if (status === 202 && htmlDoc) {
    if (hasSubstantialCareerText(body)) return { kind: 'ok', vendor: null };
    return { kind: 'challenge', vendor: 'siteground', reason: 'bot_challenge' };
  }

  if ((status === 401 || status === 403 || status === 429) && htmlDoc && text.length < SHORT_INTERSTITIAL) {
    const focus = `${pageTitle(body)}\n${scriptSrcs(body)}`;
    const keyword = /captcha|are you a robot|bot detected|access denied|forbidden/i.test(focus);
    if (keyword || text.length < THIN_TEXT) {
      return {
        kind: 'challenge',
        vendor: 'generic',
        reason: status === 429 ? 'rate_limited' : 'http_forbidden',
      };
    }
  }

  if (status === 401 || status === 403 || status === 429 || (status >= 400 && status < 500)) {
    return {
      kind: 'not_found',
      vendor: null,
      reason: status === 429 ? 'rate_limited' : status === 401 || status === 403 ? 'http_forbidden' : undefined,
    };
  }

  return { kind: 'ok', vendor: null };
}
