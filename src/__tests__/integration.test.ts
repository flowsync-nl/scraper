// src/__tests__/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { Orchestrator } from '../services/orchestrator';
import { scrapeRoutes } from '../routes/scrape';
import { ScrapeFailure } from '../services/scrape-failure';

describe('API Integration', () => {
  const fastify = Fastify();

  beforeAll(async () => {
    // Mock orchestrator for testing
    const mockOrchestrator = {
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
        return {
        domain,
        hasVacancies: true,
        vacancyCount: 1,
        vacancies: [{
          id: 'test-123',
          title: 'Test Developer',
          url: `https://${domain}/careers/test`,
          location: 'Amsterdam',
          description: 'Test vacancy',
          salary: null,
          type: 'fulltime',
          skills: ['TypeScript'],
          seniority: 'senior',
          department: 'Engineering',
          publishedAt: '2026-01-01T00:00:00Z',
          daysOpen: 22,
          scrapedAt: new Date().toISOString(),
          confidence: 0.9,
        }],
        source: {
          platform: null,
          careerPageUrl: `https://${domain}/careers`,
          method: 'ai' as const,
        },
        cached: false,
        scrapedAt: new Date().toISOString(),
      };
      },
      close: async () => {},
    } as unknown as Orchestrator;

    process.env.API_KEY = 'test-key';
    await scrapeRoutes(fastify, mockOrchestrator);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  it('should return 401 without API key', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/scrape',
      payload: { domain: 'example.nl' },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).code).toBe('unauthorized');
  });

  it('should return 400 for invalid domain', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/scrape',
      headers: { authorization: 'Bearer test-key' },
      payload: { domain: 'invalid' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('invalid_request');
  });

  it('should scrape valid domain', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/scrape',
      headers: { authorization: 'Bearer test-key' },
      payload: { domain: 'example.nl' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.domain).toBe('example.nl');
    expect(body.hasVacancies).toBe(true);
    expect(body.vacancies).toHaveLength(1);
  });

  it('maps an injected block to 422', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/scrape',
      headers: { authorization: 'Bearer test-key' },
      payload: { domain: 'blocked.nl' },
    });

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      code: 'blocked',
      reason: 'bot_challenge',
      retryable: false,
      domain: 'blocked.nl',
      target: { vendor: 'siteground', httpStatus: 202 },
    });
    expect(body.stack).toBeUndefined();
  });

  it('should return health check', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });
});
