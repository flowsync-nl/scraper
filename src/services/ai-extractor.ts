import Anthropic from '@anthropic-ai/sdk';
import { Vacancy } from '../types/vacancy';
import { createVacancyId } from '../utils/url';
import { z } from 'zod';
import { classifyFetch } from './fetch-classifier';
import { isRetryableTransport, isTimeoutError } from './net-errors';
import { ScrapeFailure } from './scrape-failure';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

interface CompletionClient {
  messages: {
    create: (body: {
      model: string;
      max_tokens: number;
      messages: Array<{ role: 'user'; content: string }>;
      signal?: AbortSignal;
      timeout?: number;
    }) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

function readStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function readErrorType(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const error = (err as { error?: { type?: unknown } }).error;
  return error && typeof error.type === 'string' ? error.type : undefined;
}

function isModelUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return readStatus(err) === 404 || readErrorType(err) === 'not_found_error' || /not_found_error/i.test(message);
}

function isRetryableAnthropic(err: unknown): boolean {
  if (isModelUnavailable(err)) return false;
  const status = readStatus(err);
  const type = readErrorType(err);
  if (status === 429 || status === 529 || type === 'rate_limit_error' || type === 'overloaded_error') return true;
  return isRetryableTransport(err);
}

function mapAnthropicFailure(err: unknown): ScrapeFailure {
  if (err instanceof ScrapeFailure) return err;
  const message = err instanceof Error ? err.message : 'Extractor failed';
  if (isModelUnavailable(err)) {
    return new ScrapeFailure({
      code: 'extractor_failed',
      reason: 'model_unavailable',
      retryable: false,
      stage: 'extract',
      message,
    });
  }
  const status = readStatus(err);
  const type = readErrorType(err);
  if (status === 429 || status === 529 || type === 'rate_limit_error' || type === 'overloaded_error') {
    return new ScrapeFailure({
      code: 'extractor_failed',
      reason: 'rate_limited',
      retryable: true,
      stage: 'extract',
      message,
    });
  }
  if (isRetryableTransport(err)) {
    return new ScrapeFailure({
      code: 'extractor_failed',
      reason: 'network',
      retryable: true,
      stage: 'extract',
      message,
    });
  }
  return new ScrapeFailure({
    code: 'extractor_failed',
    reason: 'unexpected',
    retryable: false,
    stage: 'extract',
    message,
  });
}

// Helper to coerce arrays to comma-separated strings
const stringOrArray = z.union([
  z.string(),
  z.array(z.string()).transform(arr => arr.join(', ')),
]).nullable().optional();

const AIVacancySchema = z.object({
  title: z.string(),
  url: z.string().nullable().optional(),
  location: stringOrArray,
  description: z.string().nullable().optional().transform(v => v ?? ''),
  salary_min: z.number().nullable().optional(),
  salary_max: z.number().nullable().optional(),
  salary_currency: z.string().nullable().optional(),
  salary_period: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  skills: z.array(z.string()).nullable().optional().default([]),
  seniority: z.string().nullable().optional(),
  department: stringOrArray,
  published_date: z.string().nullable().optional(),
});

const AIResponseSchema = z.object({
  vacancies: z.array(AIVacancySchema),
  confidence: z.number().min(0).max(1),
});

// Schema for detailed vacancy extraction
const AIDetailSchema = z.object({
  fullDescription: z.string().nullable().optional(),
  requirements: z.array(z.string()).optional().default([]),
  responsibilities: z.array(z.string()).optional().default([]),
  benefits: z.array(z.string()).optional().default([]),
  skills: z.array(z.string()).optional().default([]),
  education: z.string().nullable().optional(),
  experience: z.string().nullable().optional(),
  workHours: z.string().nullable().optional(),
  salary_min: z.number().nullable().optional(),
  salary_max: z.number().nullable().optional(),
  salary_currency: z.string().nullable().optional(),
  salary_period: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  remotePolicy: z.string().nullable().optional(),
  applicationDeadline: z.string().nullable().optional(),
  contactPerson: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
});

export class AIExtractor {
  private client: CompletionClient;

  constructor(apiKey: string, client?: CompletionClient) {
    this.client = client ?? (new Anthropic({ apiKey }) as unknown as CompletionClient);
  }

  private modelId(): string {
    const configured = process.env.ANTHROPIC_MODEL?.trim();
    return configured || DEFAULT_ANTHROPIC_MODEL;
  }

  private assertNotChallenge(html: string, url: string): void {
    const classification = classifyFetch(200, {}, html);
    if (classification.kind !== 'challenge') return;
    throw new ScrapeFailure({
      code: 'blocked',
      reason: classification.reason ?? 'bot_challenge',
      retryable: false,
      stage: 'extract',
      message: `Challenge HTML was not sent to the extractor for ${url}`,
      target: { url, vendor: classification.vendor },
    });
  }

  private async complete(prompt: string, maxTokens: number, signal?: AbortSignal, deadline?: number): Promise<string> {
    if (signal?.aborted || (deadline !== undefined && Date.now() >= deadline)) {
      throw this.timeoutFailure();
    }
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (signal?.aborted || (deadline !== undefined && Date.now() >= deadline)) throw this.timeoutFailure();
        const timeout = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
        const response = await this.client.messages.create({
          model: this.modelId(),
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
          ...(signal ? { signal } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
        });
        const content = response.content[0];
        if (!content || content.type !== 'text' || !content.text) {
          throw new ScrapeFailure({
            code: 'extractor_failed',
            reason: 'extractor_parse',
            retryable: false,
            stage: 'extract',
            message: 'Unexpected response type from Claude',
          });
        }
        return content.text;
      } catch (err) {
        if (err instanceof ScrapeFailure) throw err;
        if (signal?.aborted || (deadline !== undefined && Date.now() >= deadline) || isTimeoutError(err)) {
          throw this.timeoutFailure();
        }
        last = err;
        if (attempt === 0 && isRetryableAnthropic(err)) continue;
        throw mapAnthropicFailure(err);
      }
    }
    if (signal?.aborted || (deadline !== undefined && Date.now() >= deadline) || isTimeoutError(last)) {
      throw this.timeoutFailure();
    }
    throw mapAnthropicFailure(last);
  }

  private timeoutFailure(): ScrapeFailure {
    return new ScrapeFailure({
      code: 'timeout',
      reason: 'timeout',
      retryable: true,
      stage: 'extract',
      message: 'Scrape timed out',
    });
  }

  private parseModelJson<T>(text: string, parse: (value: unknown) => T): T {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new ScrapeFailure({
        code: 'extractor_failed',
        reason: 'extractor_parse',
        retryable: false,
        stage: 'extract',
        message: 'No JSON found in Claude response',
      });
    }
    try {
      return parse(JSON.parse(jsonMatch[0]));
    } catch (err) {
      throw new ScrapeFailure({
        code: 'extractor_failed',
        reason: 'extractor_parse',
        retryable: false,
        stage: 'extract',
        message: err instanceof Error ? err.message : 'Extractor parse failed',
      });
    }
  }

  cleanHtml(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80000);
  }

  buildPrompt(html: string, url: string, additionalUrls?: string[]): string {
    const cleanedHtml = this.cleanHtml(html);
    const domain = new URL(url).hostname;

    let urlListSection = '';
    if (additionalUrls && additionalUrls.length > 0) {
      urlListSection = `

SITEMAP URLS (deze URLs komen uit de sitemap en verwijzen naar vacaturepagina's):
${additionalUrls.slice(0, 50).join('\n')}

Gebruik deze URLs om:
1. Te verifiëren welke vacatures bestaan
2. De URL voor elke vacature te bepalen
3. Vacaturetitels uit de URL paden te halen (bijv. /jobs/senior-developer -> "Senior Developer")
`;
    }

    return `Je bent een expert in het extraheren van vacatures van career pagina's. Analyseer de tekst van ${domain} en vind ALLE vacatures.

BELANGRIJK:
- Zoek naar ALLE vacatures/jobs die je kunt vinden, niet alleen de eerste paar
- Elke unieke functietitel is een vacature
- Let op lijsten, kaarten, of herhalende patronen die vacatures aangeven
- Als er URLs uit de sitemap zijn meegegeven, gebruik deze om ALLE vacatures te identificeren
- Extract ook vacatures uit de URL paden als de titels daar duidelijk in staan
${urlListSection}
Voor elke vacature, extraheer (gebruik null als niet beschikbaar):
- title: functietitel (VERPLICHT)
- url: link naar de vacature (kan relatief zijn zoals "/jobs/123")
- location: locatie (stad, land, of "Remote")
- description: korte beschrijving (max 300 tekens)
- salary_min/salary_max: ALLEEN geld/salaris (bijv. 3000, 4500). NIET werkuren! Uren per week zijn GEEN salaris.
- salary_currency: valuta (EUR, USD, etc.)
- salary_period: "year", "month", of "hour" (salaris periode, NIET werkuren)
- type: "fulltime", "parttime", "contract", of "internship"
- skills: array van gevraagde skills (bijv. ["Python", "React"])
- seniority: "junior", "medior", "senior", of "lead"
- department: afdeling
- published_date: datum in ISO format (YYYY-MM-DD)

BELANGRIJK: Verwar werkuren (bijv. "32-40 uur per week") NIET met salaris. Werkuren horen bij type (fulltime/parttime), niet bij salary.

Antwoord ALLEEN met valid JSON:
{
  "vacancies": [{"title": "...", ...}],
  "confidence": 0.0-1.0
}

Tekst:
${cleanedHtml}`;
  }

  async extract(
    html: string,
    url: string,
    additionalUrls?: string[],
    signal?: AbortSignal,
    deadline?: number,
  ): Promise<{ vacancies: Vacancy[]; confidence: number }> {
    this.assertNotChallenge(html, url);
    const prompt = this.buildPrompt(html, url, additionalUrls);
    const text = await this.complete(prompt, 8192, signal, deadline);
    const parsed = this.parseModelJson(text, (value) => AIResponseSchema.parse(value));
    const now = new Date().toISOString();

    const vacancies: Vacancy[] = parsed.vacancies.map((v) => {
      const vacancyUrl = v.url ? (v.url.startsWith('http') ? v.url : new URL(v.url, url).href) : url;
      const publishedAt = v.published_date ?? null;
      const daysOpen = publishedAt
        ? Math.floor((Date.now() - new Date(publishedAt).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      return {
        id: createVacancyId(vacancyUrl + v.title),
        title: v.title,
        url: vacancyUrl,
        location: v.location ?? null,
        description: v.description ?? '',
        salary: v.salary_min || v.salary_max ? {
          min: v.salary_min ?? null,
          max: v.salary_max ?? null,
          currency: v.salary_currency ?? null,
          period: this.mapPeriod(v.salary_period ?? null),
        } : null,
        type: this.mapType(v.type ?? null),
        skills: v.skills ?? [],
        seniority: this.mapSeniority(v.seniority ?? null),
        department: v.department ?? null,
        publishedAt,
        daysOpen,
        scrapedAt: now,
        confidence: parsed.confidence,
      };
    });

    return { vacancies, confidence: parsed.confidence };
  }

  private mapType(type: string | null): Vacancy['type'] {
    if (!type) return null;
    const lower = type.toLowerCase();
    if (lower.includes('full')) return 'fulltime';
    if (lower.includes('part')) return 'parttime';
    if (lower.includes('contract')) return 'contract';
    if (lower.includes('intern')) return 'internship';
    return null;
  }

  private mapSeniority(seniority: string | null): Vacancy['seniority'] {
    if (!seniority) return null;
    const lower = seniority.toLowerCase();
    if (lower.includes('junior')) return 'junior';
    if (lower.includes('medior') || lower.includes('mid')) return 'medior';
    if (lower.includes('senior')) return 'senior';
    if (lower.includes('lead') || lower.includes('principal')) return 'lead';
    return null;
  }

  private mapPeriod(period: string | null): 'year' | 'month' | 'hour' | null {
    if (!period) return null;
    const lower = period.toLowerCase();
    if (lower.includes('year') || lower.includes('annual') || lower.includes('jaar')) return 'year';
    if (lower.includes('month') || lower.includes('maand')) return 'month';
    if (lower.includes('hour') || lower.includes('uur')) return 'hour';
    return null;
  }

  private mapRemotePolicy(policy: string | null): 'onsite' | 'hybrid' | 'remote' | null {
    if (!policy) return null;
    const lower = policy.toLowerCase();
    if (lower.includes('remote') || lower.includes('thuiswerk')) return 'remote';
    if (lower.includes('hybrid') || lower.includes('hybride')) return 'hybrid';
    if (lower.includes('onsite') || lower.includes('kantoor') || lower.includes('on-site')) return 'onsite';
    return null;
  }

  buildDetailPrompt(html: string, vacancyTitle: string): string {
    const cleanedHtml = this.cleanHtml(html);

    return `Je bent een expert in het extraheren van vacature details. Analyseer deze vacaturepagina voor "${vacancyTitle}" en extraheer alle beschikbare informatie.

Extraheer de volgende informatie (gebruik null als niet beschikbaar):

- fullDescription: volledige vacaturetekst/beschrijving
- requirements: array van vereisten/eisen (bijv. ["5+ jaar ervaring", "HBO diploma"])
- responsibilities: array van verantwoordelijkheden/taken
- benefits: array van arbeidsvoorwaarden/voordelen (bijv. ["25 vakantiedagen", "Pensioenregeling"])
- skills: array van gevraagde skills/vaardigheden
- education: opleidingsniveau (bijv. "HBO", "WO", "MBO")
- experience: ervaring vereist (bijv. "3-5 jaar", "Starter")
- workHours: werkuren per week (bijv. "40 uur", "32-40 uur") - dit is GEEN salaris!
- salary_min/salary_max: ALLEEN geldbedragen als salaris (bijv. 3000, 4500 euro). Werkuren zijn GEEN salaris!
- salary_currency: valuta (EUR, USD)
- salary_period: "year", "month", of "hour" - de periode voor het salaris
- location: locatie (stad, land)
- remotePolicy: "remote", "hybrid", of "onsite"
- applicationDeadline: sollicitatie deadline in ISO format (YYYY-MM-DD)
- contactPerson: naam van contactpersoon/recruiter

BELANGRIJK: "32-40 uur per week" = werkuren (workHours), NIET salaris. Salaris zijn geldbedragen in euro's of andere valuta.

Antwoord ALLEEN met valid JSON:
{
  "fullDescription": "...",
  "requirements": [...],
  "responsibilities": [...],
  "benefits": [...],
  "skills": [...],
  "education": "...",
  "experience": "...",
  "workHours": "...",
  "salary_min": null,
  "salary_max": null,
  "salary_currency": null,
  "salary_period": null,
  "location": "...",
  "remotePolicy": "...",
  "applicationDeadline": null,
  "contactPerson": null,
  "confidence": 0.0-1.0
}

Tekst:
${cleanedHtml}`;
  }

  async extractDetails(html: string, vacancy: Vacancy, signal?: AbortSignal, deadline?: number): Promise<Partial<Vacancy>> {
    this.assertNotChallenge(html, vacancy.url);
    const prompt = this.buildDetailPrompt(html, vacancy.title);
    const text = await this.complete(prompt, 4096, signal, deadline);
    const parsed = this.parseModelJson(text, (value) => AIDetailSchema.parse(value));

    // Merge with existing vacancy data, preferring new detailed data
    return {
      hasDetails: true,
      fullDescription: parsed.fullDescription ?? null,
      requirements: parsed.requirements ?? [],
      responsibilities: parsed.responsibilities ?? [],
      benefits: parsed.benefits ?? [],
      skills: parsed.skills?.length ? parsed.skills : vacancy.skills,
      education: parsed.education ?? null,
      experience: parsed.experience ?? null,
      workHours: parsed.workHours ?? null,
      location: parsed.location ?? vacancy.location,
      salary: parsed.salary_min || parsed.salary_max ? {
        min: parsed.salary_min ?? null,
        max: parsed.salary_max ?? null,
        currency: parsed.salary_currency ?? null,
        period: this.mapPeriod(parsed.salary_period ?? null),
      } : vacancy.salary,
      remotePolicy: this.mapRemotePolicy(parsed.remotePolicy ?? null),
      applicationDeadline: parsed.applicationDeadline ?? null,
      contactPerson: parsed.contactPerson ?? null,
      confidence: Math.max(vacancy.confidence, parsed.confidence),
    };
  }
}
