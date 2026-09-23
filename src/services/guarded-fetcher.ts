import { classifyFetch, type FetchClassification } from './fetch-classifier';
import { isRetryablePlaywright, isRetryableTransport, isTimeoutError } from './net-errors';
import { ScrapeFailure } from './scrape-failure';

export interface PageSource {
  fetchWithHttp(url: string, timeout?: number): Promise<{ html: string; status: number; headers?: Record<string, string> }>;
  fetchWithPlaywright(
    url: string,
    timeout?: number,
    mode?: 'full' | 'probe',
  ): Promise<{ html: string; status: number; headers?: Record<string, string> }>;
  needsJavaScript(html: string): boolean;
}

interface RawPage {
  html: string;
  status: number;
  headers: Record<string, string>;
}

export interface GuardedFetchResult extends RawPage {
  url: string;
  classification: FetchClassification;
}

const HTTP_CAP_MS = 10_000;
const PROBE_CAP_MS = 10_000;
const FULL_CAP_MS = 45_000;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function budgetTimeout(deadline: number | undefined, cap: number): number {
  if (deadline === undefined) return cap;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new ScrapeFailure({
      code: 'timeout',
      reason: 'timeout',
      retryable: true,
      stage: 'budget',
      message: 'Scrape budget exceeded',
    });
  }
  return Math.max(1, Math.min(cap, remaining));
}

function normalize(res: { html: string; status: number; headers?: Record<string, string> }): RawPage {
  return {
    html: res.html ?? '',
    status: res.status,
    headers: res.headers ?? {},
  };
}

/**
 * Vacancy fetch policy: one HTTP retry for transport/5xx, and one short Playwright
 * probe per host after a challenge. Challenge documents are not rendered with the
 * long cookie/scroll waits.
 */
export class GuardedFetcher {
  private readonly challengedHosts = new Set<string>();

  constructor(private readonly source: PageSource) {}

  async fetch(url: string, deadline?: number): Promise<GuardedFetchResult> {
    try {
      const httpPage = await this.fetchHttp(url, deadline);
      return await this.finishHttp(url, httpPage, deadline);
    } catch (err) {
      if (err instanceof ScrapeFailure) throw err;
      return {
        url,
        html: '',
        status: 0,
        headers: {},
        classification: {
          kind: 'transport_error',
          vendor: null,
          reason: isTimeoutError(err) ? 'timeout' : 'network',
        },
      };
    }
  }

  private async fetchHttp(url: string, deadline?: number): Promise<RawPage> {
    let lastPage: RawPage | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const timeout = budgetTimeout(deadline, HTTP_CAP_MS);
        const page = normalize(await this.source.fetchWithHttp(url, timeout));
        lastPage = page;
        const classification = classifyFetch(page.status, page.headers, page.html);
        if (attempt === 0 && classification.kind === 'upstream_error') continue;
        return page;
      } catch (err) {
        if (err instanceof ScrapeFailure) throw err;
        lastError = err;
        if (attempt === 0 && isRetryableTransport(err)) continue;
        break;
      }
    }
    if (lastPage) return lastPage;
    throw lastError ?? new Error('HTTP fetch failed');
  }

  private async finishHttp(url: string, page: RawPage, deadline?: number): Promise<GuardedFetchResult> {
    const classification = classifyFetch(page.status, page.headers, page.html);
    if (classification.kind === 'challenge') {
      return this.afterChallenge(url, page, classification, deadline);
    }
    if (classification.kind === 'ok' && this.source.needsJavaScript(page.html)) {
      return this.render(url, deadline);
    }
    return { url, ...page, classification };
  }

  private async afterChallenge(
    url: string,
    page: RawPage,
    classification: FetchClassification,
    deadline?: number,
  ): Promise<GuardedFetchResult> {
    const host = hostnameOf(url);
    if (this.challengedHosts.has(host)) {
      return { url, ...page, classification };
    }

    try {
      const probed = await this.fetchBrowser(url, deadline, 'probe');
      const probedClass = classifyFetch(probed.status, probed.headers, probed.html);
      if (probedClass.kind === 'challenge') {
        this.challengedHosts.add(host);
        return { url, ...probed, classification: probedClass };
      }
      if (probedClass.kind === 'ok' && this.source.needsJavaScript(probed.html)) {
        return this.render(url, deadline);
      }
      return { url, ...probed, classification: probedClass };
    } catch (err) {
      if (err instanceof ScrapeFailure) throw err;
      this.challengedHosts.add(host);
      return { url, ...page, classification };
    }
  }

  private async render(url: string, deadline?: number): Promise<GuardedFetchResult> {
    try {
      const full = await this.fetchBrowser(url, deadline, 'full');
      const classification = classifyFetch(full.status, full.headers, full.html);
      if (classification.kind === 'challenge') this.challengedHosts.add(hostnameOf(url));
      return { url, ...full, classification };
    } catch (err) {
      if (err instanceof ScrapeFailure) throw err;
      return {
        url,
        html: '',
        status: 0,
        headers: {},
        classification: {
          kind: 'transport_error',
          vendor: null,
          reason: isTimeoutError(err) ? 'timeout' : 'network',
        },
      };
    }
  }

  private async fetchBrowser(url: string, deadline: number | undefined, mode: 'full' | 'probe'): Promise<RawPage> {
    const cap = mode === 'probe' ? PROBE_CAP_MS : FULL_CAP_MS;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const timeout = budgetTimeout(deadline, cap);
        return normalize(await this.source.fetchWithPlaywright(url, timeout, mode));
      } catch (err) {
        if (err instanceof ScrapeFailure) throw err;
        lastError = err;
        if (attempt === 0 && isRetryablePlaywright(err)) continue;
        throw err;
      }
    }
    throw lastError ?? new Error('Browser fetch failed');
  }
}
