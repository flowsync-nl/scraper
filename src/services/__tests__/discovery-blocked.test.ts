import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from '../discovery';
import { GuardedFetcher, type PageSource } from '../guarded-fetcher';
import { Orchestrator } from '../orchestrator';
import { AIExtractor } from '../ai-extractor';
import { CacheService } from '../cache';
import { ScraperService } from '../scraper';
import { ScrapeFailure } from '../scrape-failure';
import type { Vacancy } from '../../types/vacancy';

const challengeHtml = `<html><head><title>Human verification</title><script src="/.well-known/sgcaptcha/"></script></head><body>sgcaptcha</body></html>`;
const careerHtml = `<html><head><title>Vacatures</title></head><body><h1>Vacatures</h1><p>${'Join our team in Amsterdam. '.repeat(20)}</p><footer>widget recruitee</footer></body></html>`;

function challengePage() {
  return { status: 202, html: challengeHtml, headers: { 'content-type': 'text/html' } };
}

function notFoundPage() {
  return { status: 404, html: '<html><title>Not found</title><body>missing</body></html>', headers: { 'content-type': 'text/html' } };
}

function source(handlers: Pick<PageSource, 'fetchWithHttp' | 'fetchWithPlaywright'>): PageSource & { extractCareerLinks: () => string[] } {
  return {
    ...handlers,
    needsJavaScript: () => false,
    extractCareerLinks: () => [],
  };
}

describe('discovery blocked and cache', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns blocked for an apex challenge and does not call the extractor or cache success', async () => {
    const fetched: string[] = [];
    const pages = source({
      fetchWithHttp: async (url: string) => {
        fetched.push(url);
        return challengePage();
      },
      fetchWithPlaywright: async () => challengePage(),
    });
    const extract = vi.fn();
    const cache = new CacheService();
    const orchestrator = new Orchestrator({
      anthropicApiKey: 'test-key',
      cache,
      scraper: pages as unknown as ScraperService,
      aiExtractor: { extract, extractDetails: vi.fn() } as unknown as AIExtractor,
    });

    await expect(orchestrator.scrape('example.nl')).rejects.toMatchObject({
      code: 'blocked',
      reason: 'bot_challenge',
      retryable: false,
      target: expect.objectContaining({ vendor: 'siteground', url: 'https://example.nl/vacatures' }),
    });

    expect(extract).not.toHaveBeenCalled();
    expect(fetched).toContain('https://example.nl/vacatures');
    expect(fetched).not.toContain('https://example.nl/careers');
    expect(await cache.get(cache.keyFor('example.nl'))).toBeNull();
    expect(await cache.get(cache.blockKeyFor('example.nl'))).toMatchObject({ code: 'blocked' });
  });

  it('skips a challenged guessed subdomain and still accepts the apex career page', async () => {
    const pages = source({
      fetchWithHttp: async (url: string) => {
        const host = new URL(url).hostname;
        if (host !== 'example.nl' && host !== 'www.example.nl') return challengePage();
        if (url.includes('/vacatures')) {
          return { status: 200, html: careerHtml, headers: { 'content-type': 'text/html' } };
        }
        return notFoundPage();
      },
      fetchWithPlaywright: async () => challengePage(),
    });
    const discovery = new DiscoveryService(pages as unknown as ScraperService, new GuardedFetcher(pages));
    const found = await discovery.findCareerPage('example.nl');
    expect(found?.url).toBe('https://example.nl/vacatures');
  });

  it('returns an empty success for an all-404 site with a readable homepage and caches it', async () => {
    const pages = source({
      fetchWithHttp: async (url: string) => {
        if (url === 'https://example.nl') {
          return {
            status: 200,
            html: '<html><body><p>Welcome to the bakery. Fresh bread every morning.</p></body></html>',
            headers: { 'content-type': 'text/html' },
          };
        }
        return notFoundPage();
      },
      fetchWithPlaywright: async () => {
        throw new Error('playwright should not run');
      },
    });
    const extract = vi.fn();
    const cache = new CacheService();
    const orchestrator = new Orchestrator({
      anthropicApiKey: 'test-key',
      cache,
      scraper: pages as unknown as ScraperService,
      aiExtractor: { extract, extractDetails: vi.fn() } as unknown as AIExtractor,
    });

    const result = await orchestrator.scrape('example.nl');
    expect(result).toMatchObject({
      domain: 'example.nl',
      hasVacancies: false,
      vacancyCount: 0,
      vacancies: [],
      source: { platform: null, careerPageUrl: '', method: 'ai' },
      cached: false,
    });
    expect(extract).not.toHaveBeenCalled();
    expect(await cache.get(cache.keyFor('example.nl'))).toMatchObject({ hasVacancies: false });
  });

  it('does not cache transport failures as an empty career page', async () => {
    const pages = source({
      fetchWithHttp: async () => {
        const error = new Error('socket hang up') as Error & { code: string };
        error.code = 'ECONNRESET';
        throw error;
      },
      fetchWithPlaywright: async () => {
        throw new Error('playwright should not run');
      },
    });
    const cache = new CacheService();
    const orchestrator = new Orchestrator({
      anthropicApiKey: 'test-key',
      cache,
      scraper: pages as unknown as ScraperService,
      aiExtractor: { extract: vi.fn(), extractDetails: vi.fn() } as unknown as AIExtractor,
    });

    await expect(orchestrator.scrape('example.nl')).rejects.toMatchObject({
      code: 'upstream_unavailable',
      reason: 'network',
      retryable: true,
    });
    expect(await cache.get(cache.keyFor('example.nl'))).toBeNull();
    expect(await cache.get(cache.blockKeyFor('example.nl'))).toBeNull();
  });

  it('does not parse loc entries from a challenge sitemap', () => {
    const discovery = new DiscoveryService(new ScraperService());
    const body = `<html><head><title>sgcaptcha</title></head><body><loc>https://bas-hr.nl/vacatures</loc></body></html>`;
    expect(discovery.readSitemapLocs(202, { 'content-type': 'text/html' }, body)).toEqual([]);
    expect(discovery.readSitemapLocs(
      200,
      { 'content-type': 'application/xml' },
      '<urlset><loc>https://example.nl/vacatures</loc></urlset>',
    )).toEqual(['https://example.nl/vacatures']);
  });

  it('falls through when recruitee is only mentioned on a non-recruitee host', async () => {
    const extract = vi.fn().mockResolvedValue({ vacancies: [], confidence: 0.4 });
    const discovery = {
      findCareerPage: async () => ({
        url: 'https://bas-hr.nl/vacatures',
        html: careerHtml,
        platform: 'recruitee' as const,
      }),
      extractDepartmentLinks: () => [],
    };
    const orchestrator = new Orchestrator({
      anthropicApiKey: 'test-key',
      cache: new CacheService(),
      discovery: discovery as unknown as DiscoveryService,
      aiExtractor: { extract, extractDetails: vi.fn() } as unknown as AIExtractor,
    });

    await orchestrator.scrape('bas-hr.nl');
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][1]).toBe('https://bas-hr.nl/vacatures');
  });

  it('serves a repeated block from the lock without calling discovery again', async () => {
    let calls = 0;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const discovery = {
      findCareerPage: async () => {
        calls += 1;
        throw new ScrapeFailure({
          code: 'blocked',
          reason: 'bot_challenge',
          domain: 'bas-hr.nl',
          stage: 'discovery',
          target: { url: 'https://bas-hr.nl/vacatures', httpStatus: 202, vendor: 'siteground' },
        });
      },
      extractDepartmentLinks: () => [],
    };
    const cache = new CacheService();
    const orchestrator = new Orchestrator({
      anthropicApiKey: 'test-key',
      cache,
      discovery: discovery as unknown as DiscoveryService,
      aiExtractor: { extract: vi.fn(), extractDetails: vi.fn() } as unknown as AIExtractor,
    });

    await expect(orchestrator.scrape('bas-hr.nl')).rejects.toMatchObject({ code: 'blocked' });
    await expect(orchestrator.scrape('bas-hr.nl')).rejects.toMatchObject({ code: 'blocked', stage: 'cache' });
    expect(calls).toBe(1);
    expect(info.mock.calls.some((call) => String(call[0]).includes('"chromium":false'))).toBe(true);
    expect(await cache.get(cache.keyFor('bas-hr.nl'))).toBeNull();
  });

  it('does not cache a timeout and does not start discovery when the budget is already spent', async () => {
    const findCareerPage = vi.fn();
    const cache = new CacheService();
    const orchestrator = new Orchestrator({
      anthropicApiKey: 'test-key',
      cache,
      budgetMs: 0,
      discovery: { findCareerPage, extractDepartmentLinks: () => [] } as unknown as DiscoveryService,
      aiExtractor: { extract: vi.fn(), extractDetails: vi.fn() } as unknown as AIExtractor,
    });

    await expect(orchestrator.scrape('example.nl')).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(findCareerPage).not.toHaveBeenCalled();
    expect(await cache.get(cache.keyFor('example.nl'))).toBeNull();
  });

  it('skips a blocked detail url and still returns the vacancy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const vacancy: Vacancy = {
      id: 'v1',
      title: 'Engineer',
      url: 'https://example.nl/jobs/engineer',
      location: null,
      description: 'Role',
      salary: null,
      type: 'fulltime',
      skills: [],
      seniority: null,
      department: null,
      publishedAt: null,
      daysOpen: null,
      scrapedAt: new Date().toISOString(),
      confidence: 0.8,
    };
    const extractDetails = vi.fn();
    const fetcher = {
      fetch: vi.fn(async (url: string) => ({
        url,
        html: challengeHtml,
        status: 202,
        headers: { 'content-type': 'text/html' },
        classification: { kind: 'challenge', vendor: 'siteground', reason: 'bot_challenge' },
      })),
    };
    const orchestrator = new Orchestrator({
      anthropicApiKey: 'test-key',
      cache: new CacheService(),
      fetcher: fetcher as unknown as GuardedFetcher,
      discovery: {
        findCareerPage: async () => ({
          url: 'https://example.nl/vacatures',
          html: '<html><body><h1>Vacatures</h1><p>Open roles.</p></body></html>',
          platform: null,
        }),
        extractDepartmentLinks: () => [],
      } as unknown as DiscoveryService,
      aiExtractor: {
        extract: vi.fn().mockResolvedValue({ vacancies: [vacancy], confidence: 0.8 }),
        extractDetails,
      } as unknown as AIExtractor,
    });

    const result = await orchestrator.scrape('example.nl', 1);
    expect(result.vacancyCount).toBe(1);
    expect(extractDetails).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((call) => String(call[0]).includes('"code":"blocked"'))).toBe(true);
  });
});
