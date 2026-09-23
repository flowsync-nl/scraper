import { describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { ScraperService } from '../scraper';
import { ScrapeFailure } from '../scrape-failure';

describe('ScraperService', () => {
  const scraper = new ScraperService();

  it('should detect if page needs JavaScript', () => {
    // Long enough content with meaningful text (> 500 chars of actual text)
    const htmlWithContent = `<html><body>
      <div class="jobs">
        <h1>Careers at Example Company - Join Our Amazing Team Today</h1>
        <p>We are looking for talented individuals to join our growing team. Check out our open positions below and apply today. We offer competitive salaries, great benefits, and an amazing work culture.</p>
        <div class="job-listing">
          <h2>Senior Software Developer</h2>
          <p>We need a senior developer with 5+ years of experience in TypeScript, React, and Node.js. You will be working on challenging projects with a great team of engineers.</p>
          <p>Location: Amsterdam, Netherlands - Hybrid working possible</p>
          <p>Salary: €70,000 - €90,000 per year plus benefits</p>
        </div>
        <div class="job-listing">
          <h2>Product Manager</h2>
          <p>Join our product team to help build amazing products for our customers. You will work closely with engineering, design, and business teams to deliver great features.</p>
          <p>Location: Rotterdam, Netherlands - Full time position</p>
        </div>
        <div class="job-listing">
          <h2>UX Designer</h2>
          <p>We are looking for a creative UX designer to join our design team. You will be responsible for creating intuitive and beautiful user interfaces for our web and mobile applications.</p>
          <p>Location: Utrecht, Netherlands - Remote friendly</p>
        </div>
      </div>
    </body></html>`;
    const htmlEmpty = '<html><body><div id="root"></div><script src="app.js"></script></body></html>';

    expect(scraper.needsJavaScript(htmlEmpty)).toBe(true);
    expect(scraper.needsJavaScript(htmlWithContent)).toBe(false);
  });

  it('should extract links from HTML', () => {
    const html = `
      <html><body>
        <a href="/careers">Careers</a>
        <a href="https://jobs.example.nl">Jobs</a>
        <a href="/contact">Contact</a>
      </body></html>
    `;
    const links = scraper.extractCareerLinks(html, 'https://example.nl');
    expect(links.some(l => l.includes('careers'))).toBe(true);
    expect(links.some(l => l.includes('jobs'))).toBe(true);
    expect(links.some(l => l.includes('contact'))).toBe(false);
  });

  it('relaunches a disconnected browser once and then reports browser_unavailable', async () => {
    const html = `<html><body><h1>Vacatures</h1><p>${'We are hiring a developer in Amsterdam. '.repeat(30)}</p></body></html>`;
    const fakeContext = {
      newPage: async () => ({
        addInitScript: async () => {},
        goto: async () => ({ status: () => 200, headers: () => ({ 'content-type': 'text/html' }) }),
        content: async () => html,
        waitForTimeout: async () => {},
        evaluate: async () => {},
        locator: () => ({ first: () => ({ isVisible: async () => false, click: async () => {} }) }),
      }),
      close: async () => {},
    };

    class RelaunchScraper extends ScraperService {
      launches = 0;
      constructor(private failContexts: number) {
        super();
      }
      protected override async launchBrowser(): Promise<Browser> {
        this.launches += 1;
        const launchIndex = this.launches;
        return {
          isConnected: () => true,
          close: async () => {},
          newContext: async () => {
            if (launchIndex <= this.failContexts) {
              throw new Error('Target page, context or browser has been closed');
            }
            return fakeContext;
          },
        } as unknown as Browser;
      }
    }

    const recovered = new RelaunchScraper(1);
    const page = await recovered.fetchWithPlaywright('https://example.nl/vacatures', 1000, 'probe');
    expect(page.status).toBe(200);
    expect(recovered.launches).toBe(2);
    await recovered.close();

    const dead = new RelaunchScraper(2);
    await expect(dead.fetchWithPlaywright('https://example.nl/vacatures', 1000, 'probe')).rejects.toMatchObject({
      code: 'internal',
      reason: 'browser_unavailable',
    });
    expect(dead.launches).toBe(2);
    await expect(dead.fetchWithPlaywright('https://example.nl/jobs', 1000, 'probe')).rejects.toBeInstanceOf(ScrapeFailure);
    await dead.close();
  });
});
