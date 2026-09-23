import { chromium, Browser, Page } from 'playwright';
import { classifyFetch, headersToRecord } from './fetch-classifier';
import { ScrapeFailure } from './scrape-failure';

const BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
];

const BROWSER_CONTEXT = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'nl-NL',
  timezoneId: 'Europe/Amsterdam',
};

function isBrowserDisconnect(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /has been closed|browser disconnected|Target closed|Target page, context or browser has been closed|Connection closed/i.test(message);
}

function browserFailure(err: unknown): ScrapeFailure {
  return new ScrapeFailure({
    code: 'internal',
    reason: 'browser_unavailable',
    retryable: false,
    stage: 'browser',
    message: err instanceof Error ? err.message : 'Browser unavailable',
  });
}

export class ScraperService {
  private browser: Browser | null = null;
  private relaunchUsed = false;

  needsJavaScript(html: string): boolean {
    if (html.length < 1000) return true;

    const spaIndicators = [
      /<div id="(root|app|__next)">\s*<\/div>/i,
      /loading\.\.\./i,
      /<noscript>.*enable javascript/i,
      /glimlach/i,
      /<body[^>]*>\s*<\/body>/i,
    ];

    const textContent = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const hasContent = textContent.length > 500;
    const hasSpaIndicator = spaIndicators.some(pattern => pattern.test(html));

    return hasSpaIndicator || !hasContent;
  }

  extractCareerLinks(html: string, baseUrl: string): string[] {
    const careerKeywords = ['career', 'jobs', 'vacatur', 'werken', 'join', 'hiring', 'openings'];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)/gi;
    const links: string[] = [];

    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const [, href, text] = match;
      const lowerHref = href.toLowerCase();
      const lowerText = text.toLowerCase();

      if (careerKeywords.some(kw => lowerHref.includes(kw) || lowerText.includes(kw))) {
        try {
          const fullUrl = new URL(href, baseUrl).href;
          links.push(fullUrl);
        } catch {
          // Invalid URL, skip
        }
      }
    }

    return [...new Set(links)];
  }

  async fetchWithHttp(url: string, timeout = 10000): Promise<{ html: string; status: number; headers: Record<string, string> }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VacancyBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });

      const html = await response.text();
      return { html, status: response.status, headers: headersToRecord(response.headers) };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async fetchWithPlaywright(
    url: string,
    timeout = 45000,
    mode: 'full' | 'probe' = 'full',
  ): Promise<{ html: string; status: number; headers: Record<string, string> }> {
    const context = await this.openContext();
    const page = await context.newPage();
    await this.installPatches(page);

    try {
      const response = await page.goto(url, {
        waitUntil: mode === 'probe' ? 'domcontentloaded' : 'networkidle',
        timeout,
      });
      const status = response?.status() ?? 0;
      const headers = response ? lowerCaseHeaders(response.headers()) : {};
      const earlyHtml = await page.content();

      if (mode === 'probe' || classifyFetch(status, headers, earlyHtml).kind === 'challenge') {
        return { html: earlyHtml, status, headers };
      }

      await page.waitForTimeout(3000);
      await this.dismissCookieConsent(page);

      await page.evaluate(async () => {
        for (let i = 0; i < 3; i++) {
          window.scrollBy(0, window.innerHeight);
          await new Promise(r => setTimeout(r, 500));
        }
        window.scrollTo(0, 0);
      });

      await page.waitForTimeout(2000);

      const html = await page.content();
      return { html, status, headers };
    } finally {
      await context.close();
    }
  }

  /**
   * Fetch met Playwright en voer custom interactie uit op de pagina.
   * De callback ontvangt het Page object en kan scrollen, klikken, data extracten etc.
   */
  async fetchWithPlaywrightCustom<T>(
    url: string,
    callback: (page: Page) => Promise<T>,
    timeout = 45000,
  ): Promise<{ result: T; html: string; status: number }> {
    const context = await this.openContext();
    const page = await context.newPage();
    await this.installPatches(page);

    try {
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout });
      const status = response?.status() ?? 0;

      await page.waitForTimeout(2000);
      await this.dismissCookieConsent(page);

      const result = await callback(page);
      const html = await page.content();

      return { result, html, status };
    } finally {
      await context.close();
    }
  }

  async fetch(url: string): Promise<{ html: string; usedPlaywright: boolean; status: number }> {
    try {
      const { html, status } = await this.fetchWithHttp(url);

      if (status === 200 && !this.needsJavaScript(html)) {
        return { html, usedPlaywright: false, status };
      }
    } catch {
      // HTTP failed, try Playwright
    }

    const { html, status } = await this.fetchWithPlaywright(url);
    return { html, usedPlaywright: true, status };
  }

  protected async launchBrowser(): Promise<Browser> {
    return chromium.launch({
      headless: true,
      args: BROWSER_ARGS,
    });
  }

  private async acquireBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    const dead = this.browser !== null;
    this.browser = null;

    if (dead) {
      if (this.relaunchUsed) throw browserFailure(new Error('Shared browser disconnected'));
      this.relaunchUsed = true;
    }

    try {
      this.browser = await this.launchBrowser();
      return this.browser;
    } catch (err) {
      if (this.relaunchUsed) throw browserFailure(err);
      this.relaunchUsed = true;
      try {
        this.browser = await this.launchBrowser();
        return this.browser;
      } catch (err2) {
        throw browserFailure(err2);
      }
    }
  }

  private async openContext() {
    const browser = await this.acquireBrowser();
    try {
      return await browser.newContext(BROWSER_CONTEXT);
    } catch (err) {
      if (!isBrowserDisconnect(err)) throw err;
      try {
        await browser.close();
      } catch {
        // The shared browser is already gone.
      }
      this.browser = null;
      if (this.relaunchUsed) throw browserFailure(err);
      this.relaunchUsed = true;
      const next = await this.acquireBrowser();
      try {
        return await next.newContext(BROWSER_CONTEXT);
      } catch (err2) {
        throw browserFailure(err2);
      }
    }
  }

  private async installPatches(page: Page): Promise<void> {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // @ts-ignore
      window.chrome = { runtime: {} };
    });
  }

  private async dismissCookieConsent(page: Page): Promise<void> {
    const selectors = [
      'button:has-text("Accepteren")',
      'button:has-text("Alles accepteren")',
      'button:has-text("Alle cookies accepteren")',
      'button:has-text("Accept")',
      'button:has-text("Accept all")',
      'button:has-text("Accept All Cookies")',
      'button:has-text("Akkoord")',
      'button:has-text("Toestaan")',
      'button:has-text("Ik ga akkoord")',
      'button:has-text("Begrepen")',
      'button:has-text("OK")',
      'button:has-text("Agree")',
      '#onetrust-accept-btn-handler',
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      '.cc-accept',
      '.cc-btn.cc-allow',
      '[data-cookiefirst-action="accept"]',
      '.cookie-consent-accept',
      '.js-cookie-accept',
      '#cookie-accept',
      '.cmplz-accept',
      '.cky-btn-accept',
      '[data-cky-tag="accept-button"]',
    ];

    for (const selector of selectors) {
      try {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 500 })) {
          await button.click();
          await page.waitForTimeout(1000);
          return;
        }
      } catch {
        // Selector niet gevonden, volgende proberen
      }
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}
