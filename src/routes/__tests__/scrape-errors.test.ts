import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { scrapeRoutes } from '../scrape';
import { Orchestrator } from '../../services/orchestrator';
import { ScrapeFailure } from '../../services/scrape-failure';

describe('POST /api/scrape error contract', () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  let fastify: FastifyInstance;

  const success = {
    domain: 'example.nl',
    hasVacancies: true,
    vacancyCount: 0,
    vacancies: [],
    source: { platform: null, careerPageUrl: 'https://example.nl/careers', method: 'ai' as const },
    cached: false,
    scrapedAt: new Date().toISOString(),
  };

  beforeAll(async () => {
    process.env.API_KEY = 'test-key';
    const orchestrator = {
      scrape: async (domain: string) => {
        if (domain === 'blocked.nl') {
          throw new ScrapeFailure({
            code: 'blocked',
            reason: 'bot_challenge',
            domain,
            stage: 'discovery',
            target: { url: 'https://blocked.nl/vacatures', httpStatus: 202, vendor: 'siteground' },
          });
        }
        if (domain === 'upstream.nl') {
          throw new ScrapeFailure({ code: 'upstream_unavailable', reason: 'upstream_http', domain, stage: 'discovery' });
        }
        if (domain === 'slow.nl') {
          throw new ScrapeFailure({ code: 'timeout', reason: 'timeout', domain, stage: 'budget' });
        }
        if (domain === 'model.nl') {
          throw new ScrapeFailure({ code: 'extractor_failed', reason: 'model_unavailable', domain, stage: 'extract', message: 'model not found' });
        }
        if (domain === 'limited.nl') {
          throw new ScrapeFailure({ code: 'extractor_failed', reason: 'rate_limited', domain, stage: 'extract' });
        }
        if (domain === 'browser.nl') {
          throw new ScrapeFailure({ code: 'internal', reason: 'browser_unavailable', domain, stage: 'browser' });
        }
        if (domain === 'schema.nl') {
          z.object({ title: z.string() }).parse({});
        }
        if (domain === 'boom.nl') {
          throw new Error('boom-from-orchestrator sk-ant-api03-secretvalue Bearer abc123 <html><body>secret-html</body></html>');
        }
        return { ...success, domain };
      },
      close: async () => {},
    } as unknown as Orchestrator;

    fastify = Fastify({
      logger: { level: 'info', stream },
      disableRequestLogging: true,
    });
    await scrapeRoutes(fastify, orchestrator);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  async function post(domain: string, headers?: Record<string, string>) {
    return fastify.inject({
      method: 'POST',
      url: '/api/scrape',
      headers: { authorization: 'Bearer test-key', ...headers },
      payload: { domain },
    });
  }

  it('maps ScrapeFailure codes onto the status table', async () => {
    const cases = [
      { domain: 'blocked.nl', status: 422, code: 'blocked', retryable: false },
      { domain: 'upstream.nl', status: 502, code: 'upstream_unavailable', retryable: true },
      { domain: 'slow.nl', status: 504, code: 'timeout', retryable: true },
      { domain: 'model.nl', status: 502, code: 'extractor_failed', retryable: false },
      { domain: 'limited.nl', status: 502, code: 'extractor_failed', retryable: true },
      { domain: 'browser.nl', status: 500, code: 'internal', retryable: false },
    ];

    for (const item of cases) {
      const response = await post(item.domain);
      const body = JSON.parse(response.body);
      expect(response.statusCode, item.domain).toBe(item.status);
      expect(body.code).toBe(item.code);
      expect(body.retryable).toBe(item.retryable);
      expect(body.domain).toBe(item.domain);
      expect(body.stack).toBeUndefined();
      expect(response.body).not.toContain('<html');
    }

    const blocked = JSON.parse((await post('blocked.nl')).body);
    expect(blocked).toMatchObject({
      error: 'Target blocked the scrape',
      reason: 'bot_challenge',
      target: { url: 'https://blocked.nl/vacatures', httpStatus: 202, vendor: 'siteground' },
    });
    expect(JSON.parse((await post('model.nl')).body).reason).toBe('model_unavailable');
  });

  it('maps a request ZodError to 400 invalid_request', async () => {
    const response = await post('invalid');
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Invalid request',
      code: 'invalid_request',
      retryable: false,
      domain: 'invalid',
    });
  });

  it('maps an extractor ZodError to 502 extractor_failed', async () => {
    const response = await post('schema.nl');
    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      error: 'Extractor failed',
      code: 'extractor_failed',
      reason: 'extractor_parse',
      retryable: false,
      domain: 'schema.nl',
    });
    expect(body.stack).toBeUndefined();
    expect(response.body).not.toContain('ZodError');
  });

  it('maps a bare Error to 500 internal and logs the message without secrets or HTML', async () => {
    const response = await post('boom.nl');
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(500);
    expect(body).toMatchObject({
      error: 'Scrape failed',
      code: 'internal',
      reason: 'unexpected',
      retryable: false,
      domain: 'boom.nl',
    });
    expect(body.stack).toBeUndefined();
    expect(response.body).not.toContain('boom-from-orchestrator');
    expect(response.body).not.toContain('secret-html');
    expect(response.body).not.toContain('secretvalue');

    const logged = lines.join('\n');
    expect(logged).toContain('boom-from-orchestrator');
    expect(logged).toContain('[redacted]');
    expect(logged).not.toContain('secretvalue');
    expect(logged).not.toContain('abc123');
    expect(logged).not.toContain('secret-html');
    expect(logged).not.toContain('<html');
    expect(logged).not.toContain('ANTHROPIC_API_KEY');
  });

  it('returns 401 unauthorized for a missing bearer token', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/scrape',
      payload: { domain: 'example.nl' },
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'Unauthorized',
      code: 'unauthorized',
      retryable: false,
      domain: 'example.nl',
    });
  });

  it('still returns the success body', async () => {
    const response = await post('example.nl');
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).domain).toBe('example.nl');
  });
});
