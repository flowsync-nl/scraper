import { ScraperService } from './scraper';
import { GuardedFetcher, type GuardedFetchResult } from './guarded-fetcher';
import { classifyFetch, hasCareerSignals } from './fetch-classifier';
import { ScrapeFailure } from './scrape-failure';
import { getCareerPageCandidates, hostRole, normalizeUrl } from '../utils/url';

export type Platform = 'recruitee' | 'greenhouse' | 'lever' | 'workable' | null;

export interface CareerPage {
  url: string;
  html: string;
  platform: Platform;
  additionalUrls?: string[];
}

const CAREER_KEYWORDS = [
  'career', 'careers', 'job', 'jobs', 'vacatur', 'vacancies', 'vacancy',
  'werken', 'werk', 'hiring', 'openings', 'positions', 'join',
  'recruitment', 'talent', 'opportunities', 'sollicit',
];

interface DiscoverySignals {
  sawOk: boolean;
  sawNotFound: boolean;
  sawUpstream: boolean;
  sawNetwork: boolean;
  sawTimeout: boolean;
}

function freshSignals(): DiscoverySignals {
  return {
    sawOk: false,
    sawNotFound: false,
    sawUpstream: false,
    sawNetwork: false,
    sawTimeout: false,
  };
}

export class DiscoveryService {
  private readonly fetcher: GuardedFetcher;

  constructor(private scraper: ScraperService, fetcher?: GuardedFetcher) {
    this.fetcher = fetcher ?? new GuardedFetcher(scraper);
  }

  async fetchSitemapUrls(domain: string, deadline?: number): Promise<string[]> {
    this.assertBudget(deadline, domain);
    const baseUrl = normalizeUrl(domain);
    const sitemapUrls = [
      `${baseUrl}/sitemap.xml`,
      `${baseUrl}/sitemap_index.xml`,
      `${baseUrl}/sitemap-index.xml`,
      `${baseUrl}/sitemaps.xml`,
    ];

    const allUrls: string[] = [];

    for (const sitemapUrl of sitemapUrls) {
      this.assertBudget(deadline, domain);
      try {
        const response = await fetch(sitemapUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VacancyBot/1.0)' },
          signal: AbortSignal.timeout(this.remainingTimeout(deadline, domain, 10000)),
        });

        if (!response.ok) continue;

        const xml = await response.text();
        const urls = this.readSitemapLocs(response.status, response.headers, xml);
        if (urls.length === 0) continue;

        const nestedSitemaps = urls.filter(u => u.endsWith('.xml'));
        if (nestedSitemaps.length > 0) {
          const careerSitemaps = nestedSitemaps.filter(u =>
            CAREER_KEYWORDS.some(kw => u.toLowerCase().includes(kw))
          );

          for (const nestedUrl of careerSitemaps.slice(0, 3)) {
            this.assertBudget(deadline, domain);
            try {
              const nestedResponse = await fetch(nestedUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VacancyBot/1.0)' },
                signal: AbortSignal.timeout(this.remainingTimeout(deadline, domain, 10000)),
              });
              if (!nestedResponse.ok) continue;
              const nestedXml = await nestedResponse.text();
              allUrls.push(...this.readSitemapLocs(nestedResponse.status, nestedResponse.headers, nestedXml));
            } catch (err) {
              if (err instanceof ScrapeFailure) throw err;
              if (deadline !== undefined && Date.now() >= deadline) {
                throw new ScrapeFailure({
                  code: 'timeout',
                  reason: 'timeout',
                  retryable: true,
                  domain,
                  stage: 'budget',
                  message: 'Scrape budget exceeded',
                });
              }
              continue;
            }
          }
        }

        allUrls.push(...urls);

        if (allUrls.length > 0) break;
      } catch (err) {
        if (err instanceof ScrapeFailure) throw err;
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new ScrapeFailure({
            code: 'timeout',
            reason: 'timeout',
            retryable: true,
            domain,
            stage: 'budget',
            message: 'Scrape budget exceeded',
          });
        }
        continue;
      }
    }

    return allUrls.filter(url => {
      const lower = url.toLowerCase();
      return CAREER_KEYWORDS.some(kw => lower.includes(kw));
    });
  }

  async fetchAllSitemapUrls(domain: string): Promise<string[]> {
    const baseUrl = normalizeUrl(domain);
    const sitemapUrls = [
      `${baseUrl}/sitemap.xml`,
      `${baseUrl}/sitemap_index.xml`,
      `${baseUrl}/sitemap-index.xml`,
      `${baseUrl}/sitemaps.xml`,
    ];

    const allUrls: string[] = [];

    for (const sitemapUrl of sitemapUrls) {
      try {
        const response = await fetch(sitemapUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChatSyncBot/1.0)' },
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) continue;

        const xml = await response.text();
        const urls = this.parseSitemapXml(xml);

        const nestedSitemaps = urls.filter(u => u.endsWith('.xml'));
        if (nestedSitemaps.length > 0) {
          for (const nestedUrl of nestedSitemaps.slice(0, 10)) {
            try {
              const nestedResponse = await fetch(nestedUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChatSyncBot/1.0)' },
                signal: AbortSignal.timeout(10000),
              });
              if (nestedResponse.ok) {
                const nestedXml = await nestedResponse.text();
                allUrls.push(...this.parseSitemapXml(nestedXml));
              }
            } catch {
              continue;
            }
          }
        }

        allUrls.push(...urls.filter(u => !u.endsWith('.xml')));

        if (allUrls.length > 0) break;
      } catch {
        continue;
      }
    }

    return [...new Set(allUrls)];
  }

  /** Sitemap locs, or nothing when the body is a challenge or an error page. */
  readSitemapLocs(
    status: number,
    headers: Headers | Record<string, string> | undefined,
    body: string,
  ): string[] {
    if (classifyFetch(status, headers, body).kind !== 'ok') return [];
    return this.parseSitemapXml(body);
  }

  parseSitemapXml(xml: string): string[] {
    const urls: string[] = [];
    const locRegex = /<loc>([^<]+)<\/loc>/gi;
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
      urls.push(match[1].trim());
    }
    return urls;
  }

  detectPlatform(url: string): Platform {
    const lower = url.toLowerCase();

    if (lower.includes('recruitee.com')) return 'recruitee';
    if (lower.includes('greenhouse.io')) return 'greenhouse';
    if (lower.includes('lever.co')) return 'lever';
    if (lower.includes('workable.com')) return 'workable';

    return null;
  }

  detectPlatformFromHtml(html: string): Platform {
    const lower = html.toLowerCase();

    if (lower.includes('recruitee') || lower.includes('d3ii2lldyojfer.cloudfront.net')) {
      return 'recruitee';
    }
    if (lower.includes('greenhouse-jobboard') || lower.includes('boards.greenhouse.io')) {
      return 'greenhouse';
    }
    if (lower.includes('lever-jobs') || lower.includes('jobs.lever.co')) {
      return 'lever';
    }
    if (lower.includes('workable-careers')) {
      return 'workable';
    }

    return null;
  }

  async findCareerPage(domain: string, deadline?: number): Promise<CareerPage | null> {
    this.assertBudget(deadline, domain);
    const signals = freshSignals();
    const sitemapUrls = await this.fetchSitemapUrls(domain, deadline);
    console.log(`Found ${sitemapUrls.length} career-related URLs in sitemap`);
    const additional = sitemapUrls.slice(0, 50);

    if (sitemapUrls.length > 0) {
      const sortedUrls = this.sortCareerUrls(sitemapUrls);
      for (const url of sortedUrls.slice(0, 5)) {
        const found = await this.consider(url, domain, deadline, signals, additional);
        if (found) return found;
      }
    }

    for (const url of getCareerPageCandidates(domain)) {
      const found = await this.consider(url, domain, deadline, signals, additional);
      if (found) return found;
    }

    const homeUrl = normalizeUrl(domain);
    this.assertBudget(deadline, domain);
    let home: GuardedFetchResult;
    try {
      home = await this.fetcher.fetch(homeUrl, deadline);
    } catch (err) {
      if (err instanceof ScrapeFailure) {
        err.attachDomain(domain);
        throw err;
      }
      signals.sawNetwork = true;
      return this.finish(domain, signals, deadline);
    }

    const homePage = this.observe(home, homeUrl, domain, signals, additional);
    if (homePage) return homePage;

    if (home.classification.kind === 'ok') {
      const careerLinks = this.scraper.extractCareerLinks(home.html, homeUrl);
      for (const link of careerLinks.slice(0, 3)) {
        const found = await this.consider(link, domain, deadline, signals, additional);
        if (found) return found;
      }
    }

    return this.finish(domain, signals, deadline);
  }

  private async consider(
    url: string,
    domain: string,
    deadline: number | undefined,
    signals: DiscoverySignals,
    additionalUrls: string[],
  ): Promise<CareerPage | null> {
    this.assertBudget(deadline, domain);
    let fetched: GuardedFetchResult;
    try {
      fetched = await this.fetcher.fetch(url, deadline);
    } catch (err) {
      if (err instanceof ScrapeFailure) {
        err.attachDomain(domain);
        throw err;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new ScrapeFailure({
          code: 'timeout',
          reason: 'timeout',
          retryable: true,
          domain,
          stage: 'budget',
          message: 'Scrape budget exceeded',
        });
      }
      signals.sawNetwork = true;
      return null;
    }
    return this.observe(fetched, url, domain, signals, additionalUrls);
  }

  private observe(
    fetched: GuardedFetchResult,
    url: string,
    domain: string,
    signals: DiscoverySignals,
    additionalUrls: string[],
  ): CareerPage | null {
    const { classification } = fetched;
    switch (classification.kind) {
      case 'challenge': {
        const role = hostRole(url, domain);
        if (role === 'apex' || role === 'www') {
          throw new ScrapeFailure({
            code: 'blocked',
            reason: classification.reason ?? 'bot_challenge',
            retryable: false,
            domain,
            stage: 'discovery',
            message: `Challenge from ${classification.vendor ?? 'unknown'} at ${url}`,
            target: {
              url,
              httpStatus: fetched.status,
              vendor: classification.vendor,
            },
          });
        }
        console.info(JSON.stringify({
          msg: 'scrape skip challenged subdomain',
          domain,
          url,
          vendor: classification.vendor,
        }));
        return null;
      }
      case 'not_found':
        signals.sawNotFound = true;
        return null;
      case 'upstream_error':
        signals.sawUpstream = true;
        return null;
      case 'transport_error':
        if (classification.reason === 'timeout') signals.sawTimeout = true;
        else signals.sawNetwork = true;
        return null;
      case 'ok':
        signals.sawOk = true;
        if (this.looksLikeCareerPage(fetched.html)) {
          const platform = this.detectPlatform(url) || this.detectPlatformFromHtml(fetched.html);
          return { url, html: fetched.html, platform, additionalUrls };
        }
        return null;
      default:
        return null;
    }
  }

  private finish(domain: string, signals: DiscoverySignals, deadline?: number): null {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new ScrapeFailure({
        code: 'timeout',
        reason: 'timeout',
        retryable: true,
        domain,
        stage: signals.sawTimeout ? 'discovery' : 'budget',
        message: signals.sawTimeout
          ? 'Scrape timed out while fetching the career page'
          : 'Scrape budget exceeded',
      });
    }

    const genuineEmpty = signals.sawOk
      || (signals.sawNotFound && !signals.sawUpstream && !signals.sawNetwork && !signals.sawTimeout);
    if (genuineEmpty) return null;

    if (signals.sawTimeout && !signals.sawUpstream) {
      throw new ScrapeFailure({
        code: 'timeout',
        reason: 'timeout',
        retryable: true,
        domain,
        stage: 'discovery',
        message: 'Scrape timed out while fetching the career page',
      });
    }

    throw new ScrapeFailure({
      code: 'upstream_unavailable',
      reason: signals.sawUpstream ? 'upstream_http' : 'network',
      retryable: true,
      domain,
      stage: 'discovery',
      message: signals.sawUpstream ? 'Target returned an upstream error' : 'Target could not be reached',
    });
  }

  private assertBudget(deadline: number | undefined, domain: string): void {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new ScrapeFailure({
        code: 'timeout',
        reason: 'timeout',
        retryable: true,
        domain,
        stage: 'budget',
        message: 'Scrape budget exceeded',
      });
    }
  }

  private remainingTimeout(deadline: number | undefined, domain: string, cap: number): number {
    if (deadline === undefined) return cap;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ScrapeFailure({
        code: 'timeout',
        reason: 'timeout',
        retryable: true,
        domain,
        stage: 'budget',
        message: 'Scrape budget exceeded',
      });
    }
    return Math.max(1, Math.min(cap, remaining));
  }

  private sortCareerUrls(urls: string[]): string[] {
    const mainPagePatterns = [
      /\/(careers?|jobs?|vacatures?|werken-bij|werkenbij)\/?$/i,
      /\/(careers?|jobs?|vacatures?)\/(overview|all|list)?\/?$/i,
    ];

    return urls.sort((a, b) => {
      const aIsMain = mainPagePatterns.some(p => p.test(a));
      const bIsMain = mainPagePatterns.some(p => p.test(b));
      if (aIsMain && !bIsMain) return -1;
      if (bIsMain && !aIsMain) return 1;
      return a.length - b.length;
    });
  }

  private looksLikeCareerPage(html: string): boolean {
    return hasCareerSignals(html);
  }

  extractDepartmentLinks(html: string, baseUrl: string): string[] {
    const links: string[] = [];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;

    const departmentKeywords = [
      'tech', 'engineering', 'development', 'software',
      'marketing', 'sales', 'finance', 'hr', 'legal',
      'operations', 'logistics', 'support', 'service',
      'design', 'product', 'data', 'analytics',
      'hoofdkantoor', 'magazijn', 'bezorging', 'winkels',
      'klantenservice', 'stage', 'bijbanen',
    ];

    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const lower = href.toLowerCase();

      if (departmentKeywords.some(kw => lower.includes(kw))) {
        try {
          const fullUrl = new URL(href, baseUrl).href;
          if (fullUrl.includes(new URL(baseUrl).hostname.replace('www.', ''))) {
            links.push(fullUrl);
          }
        } catch {
          // Invalid URL
        }
      }
    }

    return [...new Set(links)];
  }
}
