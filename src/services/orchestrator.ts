import { CacheService } from './cache';
import { ScraperService } from './scraper';
import { DiscoveryService } from './discovery';
import { AIExtractor } from './ai-extractor';
import { parseWithPlatform } from './platforms';
import { GuardedFetcher, type GuardedFetchResult } from './guarded-fetcher';
import { classifyFetch } from './fetch-classifier';
import { BlockLock, safeErrorMessage, ScrapeFailure } from './scrape-failure';
import { isTimeoutError } from './net-errors';
import { ScrapeResponse, Vacancy } from '../types/vacancy';

export const SCRAPE_BUDGET_MS = 18_000;
const BLOCK_LOCK_SECONDS = 10 * 60;

export class Orchestrator {
  private cache: CacheService;
  private scraper: ScraperService;
  private discovery: DiscoveryService;
  private aiExtractor: AIExtractor;
  private fetcher: GuardedFetcher;
  private budgetMs: number;

  constructor(config: {
    redisUrl?: string;
    anthropicApiKey: string;
    cache?: CacheService;
    scraper?: ScraperService;
    discovery?: DiscoveryService;
    aiExtractor?: AIExtractor;
    fetcher?: GuardedFetcher;
    budgetMs?: number;
  }) {
    this.cache = config.cache ?? new CacheService(config.redisUrl);
    this.scraper = config.scraper ?? new ScraperService();
    this.fetcher = config.fetcher ?? new GuardedFetcher(this.scraper);
    this.discovery = config.discovery ?? new DiscoveryService(this.scraper, this.fetcher);
    this.aiExtractor = config.aiExtractor ?? new AIExtractor(config.anthropicApiKey);
    this.budgetMs = config.budgetMs ?? SCRAPE_BUDGET_MS;
  }

  async scrape(domain: string, detailLimit: number = 0): Promise<ScrapeResponse> {
    const cacheKey = this.cache.keyFor(domain + (detailLimit > 0 ? `:details:${detailLimit}` : ''));

    const cached = await this.cache.get<ScrapeResponse>(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    const lockKey = this.cache.blockKeyFor(domain);
    const locked = await this.cache.get<BlockLock>(lockKey);
    if (locked?.code === 'blocked') {
      console.info(JSON.stringify({
        msg: 'scrape block lock hit',
        domain,
        code: 'blocked',
        chromium: false,
      }));
      throw ScrapeFailure.fromLock(locked, domain);
    }

    const deadline = Date.now() + this.budgetMs;
    const signal = AbortSignal.timeout(Math.max(0, this.budgetMs));
    try {
      return await this.withDeadline(
        signal,
        domain,
        this.scrapeUncached(domain, detailLimit, cacheKey, deadline, signal),
      );
    } catch (err) {
      const failure = this.normalizeBudgetError(err, domain, signal);
      if (failure instanceof ScrapeFailure) {
        failure.attachDomain(domain);
        if (failure.code === 'blocked') {
          await this.cache.set(lockKey, failure.toLock(), BLOCK_LOCK_SECONDS);
        }
      }
      throw failure;
    }
  }

  /** Rejects when the scrape budget elapses, even if an inner await never returns. */
  private withDeadline<T>(signal: AbortSignal, domain: string, work: Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(this.budgetFailure(domain));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(this.budgetFailure(domain));
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) reject(this.budgetFailure(domain));
          else resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  private normalizeBudgetError(err: unknown, domain: string, signal: AbortSignal): unknown {
    if (err instanceof ScrapeFailure) return err;
    if (signal.aborted || isTimeoutError(err)) return this.budgetFailure(domain);
    return err;
  }

  private budgetFailure(domain: string): ScrapeFailure {
    return new ScrapeFailure({
      code: 'timeout',
      reason: 'timeout',
      retryable: true,
      domain,
      stage: 'budget',
      message: 'Scrape budget exceeded',
    });
  }

  private async scrapeUncached(
    domain: string,
    detailLimit: number,
    cacheKey: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<ScrapeResponse> {
    this.assertBudget(deadline, domain);
    const careerPage = await this.discovery.findCareerPage(domain, deadline);

    if (!careerPage) {
      this.assertBudget(deadline, domain);
      const response = this.emptyResponse(domain);
      await this.cache.set(cacheKey, response);
      return response;
    }

    this.assertPageAllowed(careerPage.html, careerPage.url, domain);

    let vacancies: Vacancy[] | undefined;
    let method: 'parser' | 'ai' = 'ai';

    if (careerPage.platform) {
      const platformVacancies = await parseWithPlatform(careerPage.platform, careerPage.url);
      if (platformVacancies) {
        vacancies = platformVacancies;
        method = 'parser';
      }
    }

    if (!vacancies) {
      const result = await this.aiExtractor.extract(
        careerPage.html,
        careerPage.url,
        careerPage.additionalUrls,
        signal,
        deadline,
      );
      vacancies = result.vacancies;
      method = 'ai';

      if (vacancies.length < 5) {
        const departmentLinks = this.discovery.extractDepartmentLinks(careerPage.html, careerPage.url);
        console.log(`Found ${departmentLinks.length} department links to check`);

        for (const deptUrl of departmentLinks.slice(0, 5)) {
          this.assertBudget(deadline, domain);
          try {
            const deptPage = await this.fetcher.fetch(deptUrl, deadline);
            if (deptPage.classification.kind === 'challenge') {
              this.warnBlocked(domain, deptUrl, deptPage, 'department');
              continue;
            }
            if (deptPage.classification.kind !== 'ok') continue;
            this.assertPageAllowed(deptPage.html, deptUrl, domain);
            const deptResult = await this.aiExtractor.extract(deptPage.html, deptUrl, undefined, signal, deadline);

            const existingIds = new Set(vacancies.map(v => v.id));
            for (const vacancy of deptResult.vacancies) {
              if (!existingIds.has(vacancy.id)) {
                vacancies.push(vacancy);
                existingIds.add(vacancy.id);
              }
            }
          } catch (err) {
            this.rethrowFatal(err);
            this.rethrowIfBudget(err, deadline, domain, signal);
            console.error(`Failed to scrape department page ${deptUrl}: ${safeErrorMessage(err)}`);
          }
        }
      }
    }

    if (detailLimit > 0 && vacancies.length > 0) {
      console.log(`Scraping details for up to ${detailLimit} vacancies...`);
      const vacanciesToDetail = vacancies.slice(0, detailLimit);

      for (let i = 0; i < vacanciesToDetail.length; i++) {
        this.assertBudget(deadline, domain);
        const vacancy = vacanciesToDetail[i];
        if (vacancy.url === careerPage.url) {
          console.log(`Skipping ${vacancy.title} - no dedicated page`);
          continue;
        }

        try {
          console.log(`[${i + 1}/${vacanciesToDetail.length}] Fetching details for: ${vacancy.title}`);
          const detailPage = await this.fetcher.fetch(vacancy.url, deadline);
          if (detailPage.classification.kind === 'challenge') {
            this.warnBlocked(domain, vacancy.url, detailPage, 'detail');
            continue;
          }
          if (detailPage.classification.kind !== 'ok') continue;
          this.assertPageAllowed(detailPage.html, vacancy.url, domain);
          const details = await this.aiExtractor.extractDetails(detailPage.html, vacancy, signal, deadline);
          Object.assign(vacancy, details);
          console.log(`  ✓ Got details: ${details.requirements?.length || 0} requirements, ${details.benefits?.length || 0} benefits`);
        } catch (err) {
          this.rethrowFatal(err);
          this.rethrowIfBudget(err, deadline, domain, signal);
          console.error(`  ✗ Failed to get details for ${vacancy.title}: ${safeErrorMessage(err)}`);
        }
      }
    }

    const response: ScrapeResponse = {
      domain,
      hasVacancies: vacancies.length > 0,
      vacancyCount: vacancies.length,
      vacancies,
      source: {
        platform: careerPage.platform,
        careerPageUrl: careerPage.url,
        method,
      },
      cached: false,
      scrapedAt: new Date().toISOString(),
    };

    if (signal.aborted || Date.now() >= deadline) {
      throw this.budgetFailure(domain);
    }
    await this.cache.set(cacheKey, response);
    return response;
  }

  private emptyResponse(domain: string): ScrapeResponse {
    return {
      domain,
      hasVacancies: false,
      vacancyCount: 0,
      vacancies: [],
      source: {
        platform: null,
        careerPageUrl: '',
        method: 'ai',
      },
      cached: false,
      scrapedAt: new Date().toISOString(),
    };
  }

  private assertBudget(deadline: number, domain: string): void {
    if (Date.now() >= deadline) {
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

  private assertPageAllowed(html: string, url: string, domain: string): void {
    const classification = classifyFetch(200, {}, html);
    if (classification.kind !== 'challenge') return;
    throw new ScrapeFailure({
      code: 'blocked',
      reason: classification.reason ?? 'bot_challenge',
      retryable: false,
      domain,
      stage: 'extract',
      message: `Challenge HTML blocked before extraction at ${url}`,
      target: { url, vendor: classification.vendor },
    });
  }

  private warnBlocked(domain: string, url: string, page: GuardedFetchResult, where: string): void {
    console.warn(JSON.stringify({
      msg: 'scrape blocked url skipped',
      domain,
      code: 'blocked',
      url,
      vendor: page.classification.vendor,
      httpStatus: page.status,
      where,
    }));
  }

  private rethrowFatal(err: unknown): void {
    if (!(err instanceof ScrapeFailure)) return;
    if (err.code === 'timeout' || err.reason === 'model_unavailable' || err.reason === 'browser_unavailable') {
      throw err;
    }
  }

  /** A budget abort must leave the department/detail loop; other failures stay skippable. */
  private rethrowIfBudget(err: unknown, deadline: number, domain: string, signal: AbortSignal): void {
    if (err instanceof ScrapeFailure && err.code === 'timeout') throw err;
    if (signal.aborted || Date.now() >= deadline) {
      throw this.budgetFailure(domain);
    }
  }

  async close(): Promise<void> {
    await Promise.all([
      this.cache.close(),
      this.scraper.close(),
    ]);
  }
}
