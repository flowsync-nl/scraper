import { describe, expect, it } from 'vitest';
import { classifyFetch, hasCareerSignals } from '../fetch-classifier';

const careerText = 'We are hiring. Open vacancy for a senior engineer in Amsterdam. Join our team. '.repeat(12);

function careerPage(extra = ''): string {
  return `<html><head><title>Vacatures</title></head><body><h1>Vacatures</h1><p>${careerText}</p>${extra}</body></html>`;
}

describe('classifyFetch', () => {
  it('classifies a SiteGround 202 page with sgcaptcha as a challenge', () => {
    const html = `<html><head><title>Human verification</title><script src="/.well-known/sgcaptcha/"></script></head><body>sgcaptcha</body></html>`;
    const result = classifyFetch(202, { 'content-type': 'text/html' }, html);
    expect(result.kind).toBe('challenge');
    expect(result.vendor).toBe('siteground');
    expect(result.reason).toBe('bot_challenge');
  });

  it('classifies a Cloudflare interstitial by its title', () => {
    const html = '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>';
    const result = classifyFetch(403, { 'content-type': 'text/html' }, html);
    expect(result.kind).toBe('challenge');
    expect(result.vendor).toBe('cloudflare');
  });

  it('classifies a DataDome response from the header', () => {
    const result = classifyFetch(403, { 'x-datadome': 'protected', 'content-type': 'text/html' }, '<html><body>blocked</body></html>');
    expect(result.kind).toBe('challenge');
    expect(result.vendor).toBe('datadome');
  });

  it('keeps a long vacancy page with an application reCAPTCHA as ok', () => {
    const html = careerPage('<div class="g-recaptcha"></div><script src="https://www.google.com/recaptcha/api.js"></script>');
    const result = classifyFetch(200, { 'content-type': 'text/html' }, html);
    expect(result.kind).toBe('ok');
    expect(result.vendor).toBeNull();
  });

  it('does not treat an echoed career URL inside a thin challenge as a career page', () => {
    const html = '<html><head><title>Just a moment...</title></head><body><p>https://bas-hr.nl/vacatures</p><script src="/cdn-cgi/challenge-platform/h/g/orchestrate.js"></script></body></html>';
    expect(hasCareerSignals(html)).toBe(true);
    const result = classifyFetch(200, { 'content-type': 'text/html' }, html);
    expect(result.kind).toBe('challenge');
    expect(result.vendor).toBe('cloudflare');
  });

  it('classifies HTTP 404 as not_found and HTTP 503 as upstream_error', () => {
    expect(classifyFetch(404, { 'content-type': 'text/html' }, '<html><title>Not found</title><body>missing</body></html>').kind).toBe('not_found');
    expect(classifyFetch(503, { 'content-type': 'text/html' }, '<html><body>unavailable</body></html>')).toMatchObject({
      kind: 'upstream_error',
      reason: 'upstream_http',
    });
  });

  it('keeps a legitimate HTTP 202 career page that has no vendor marker', () => {
    const result = classifyFetch(202, { 'content-type': 'text/html' }, careerPage());
    expect(result.kind).toBe('ok');
  });

  it('treats a thin HTTP 202 HTML body as a SiteGround challenge', () => {
    const result = classifyFetch(202, { 'content-type': 'text/html' }, '<html><body>please wait</body></html>');
    expect(result).toMatchObject({ kind: 'challenge', vendor: 'siteground', reason: 'bot_challenge' });
  });

  it('treats a sgcaptcha cookie as SiteGround even when the body is empty', () => {
    const result = classifyFetch(200, { 'set-cookie': 'sgcaptcha=1; Path=/' }, '');
    expect(result).toMatchObject({ kind: 'challenge', vendor: 'siteground' });
  });
});
