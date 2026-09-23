import { describe, expect, it } from 'vitest';
import { GuardedFetcher, type PageSource } from '../guarded-fetcher';

const challengeHtml = `<html><head><title>Human verification</title><script src="/.well-known/sgcaptcha/"></script></head><body>sgcaptcha https://bas-hr.nl/vacatures</body></html>`;
const okHtml = '<html><head><title>Vacatures</title></head><body><h1>Vacatures</h1><p>We are hiring in Amsterdam.</p></body></html>';

function page(status: number, html: string) {
  return { status, html, headers: { 'content-type': 'text/html' } };
}

describe('GuardedFetcher', () => {
  it('probes a challenged host once and does not call goto again', async () => {
    let httpCalls = 0;
    let gotoCalls = 0;
    const source: PageSource = {
      fetchWithHttp: async () => {
        httpCalls += 1;
        return page(202, challengeHtml);
      },
      fetchWithPlaywright: async () => {
        gotoCalls += 1;
        return page(202, challengeHtml);
      },
      needsJavaScript: () => false,
    };

    const fetcher = new GuardedFetcher(source);
    const first = await fetcher.fetch('https://bas-hr.nl/vacatures');
    const second = await fetcher.fetch('https://bas-hr.nl/jobs');

    expect(first.classification.kind).toBe('challenge');
    expect(second.classification.kind).toBe('challenge');
    expect(httpCalls).toBe(2);
    expect(gotoCalls).toBe(1);
  });

  it('retries a connection reset once and does not retry a challenge', async () => {
    let resets = 0;
    const resetSource: PageSource = {
      fetchWithHttp: async () => {
        resets += 1;
        if (resets === 1) {
          const error = new Error('socket hang up') as Error & { code: string };
          error.code = 'ECONNRESET';
          throw error;
        }
        return page(200, okHtml);
      },
      fetchWithPlaywright: async () => {
        throw new Error('playwright should not run');
      },
      needsJavaScript: () => false,
    };

    const resetResult = await new GuardedFetcher(resetSource).fetch('https://example.nl/vacatures');
    expect(resets).toBe(2);
    expect(resetResult.classification.kind).toBe('ok');

    let challengeHttp = 0;
    const challengeSource: PageSource = {
      fetchWithHttp: async () => {
        challengeHttp += 1;
        return page(202, challengeHtml);
      },
      fetchWithPlaywright: async () => page(202, challengeHtml),
      needsJavaScript: () => false,
    };
    const blocked = await new GuardedFetcher(challengeSource).fetch('https://bas-hr.nl/vacatures');
    expect(challengeHttp).toBe(1);
    expect(blocked.classification.kind).toBe('challenge');
  });

  it('retries a target 503 once and does not open a browser for 404', async () => {
    let calls = 0;
    const source: PageSource = {
      fetchWithHttp: async () => {
        calls += 1;
        if (calls === 1) return page(503, '<html><body>down</body></html>');
        return page(200, okHtml);
      },
      fetchWithPlaywright: async () => {
        throw new Error('playwright should not run');
      },
      needsJavaScript: () => false,
    };
    const result = await new GuardedFetcher(source).fetch('https://example.nl/vacatures');
    expect(calls).toBe(2);
    expect(result.classification.kind).toBe('ok');

    let missing = 0;
    let gotoCalls = 0;
    const missingSource: PageSource = {
      fetchWithHttp: async () => {
        missing += 1;
        return page(404, '<html><title>Not found</title><body>missing</body></html>');
      },
      fetchWithPlaywright: async () => {
        gotoCalls += 1;
        return page(404, 'nope');
      },
      needsJavaScript: () => true,
    };
    const notFound = await new GuardedFetcher(missingSource).fetch('https://example.nl/nope');
    expect(missing).toBe(1);
    expect(gotoCalls).toBe(0);
    expect(notFound.classification.kind).toBe('not_found');
  });
});
