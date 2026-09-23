import { Platform } from '../discovery';
import { Vacancy } from '../../types/vacancy';
import { RecruiteeParser } from './recruitee';
import { ScrapeFailure } from '../scrape-failure';

export async function parseWithPlatform(platform: Platform, url: string): Promise<Vacancy[] | null> {
  switch (platform) {
    case 'recruitee': {
      const parser = new RecruiteeParser();
      // A footer mention of Recruitee is not a company board. Fall through to AI.
      if (!parser.extractCompanyId(url)) return null;
      try {
        return await parser.parse(url);
      } catch (err) {
        if (err instanceof ScrapeFailure) throw err;
        throw new ScrapeFailure({
          code: 'extractor_failed',
          reason: 'parser_failed',
          retryable: false,
          stage: 'parser',
          message: err instanceof Error ? err.message : 'Recruitee parser failed',
        });
      }
    }
    default:
      return null;
  }
}

export { RecruiteeParser };
