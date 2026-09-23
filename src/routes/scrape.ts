// src/routes/scrape.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { Orchestrator } from '../services/orchestrator';
import { ScrapeRequestSchema } from '../types/vacancy';
import { ScrapeFailure, scrapeErrorResponse, scrapeLogFields } from '../services/scrape-failure';

function readDomain(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('domain' in body)) return undefined;
  const domain = (body as { domain?: unknown }).domain;
  return typeof domain === 'string' ? domain : undefined;
}

export async function scrapeRoutes(fastify: FastifyInstance, orchestrator: Orchestrator) {
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api/')) {
      return;
    }

    const apiKey = request.headers['authorization']?.replace('Bearer ', '');
    const expectedKey = process.env.API_KEY;

    if (!expectedKey || apiKey !== expectedKey) {
      const path = request.url.split('?')[0];
      if (path === '/api/scrape') {
        const domain = readDomain(request.body);
        const mapped = scrapeErrorResponse(new ScrapeFailure({
          code: 'unauthorized',
          domain,
          stage: 'auth',
          message: 'Unauthorized',
        }), domain);
        return reply.code(mapped.status).send(mapped.body);
      }
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.post('/api/scrape', async (request: FastifyRequest, reply: FastifyReply) => {
    const domain = readDomain(request.body);

    let body: { domain: string; detailLimit: number };
    try {
      body = ScrapeRequestSchema.parse(request.body);
    } catch (error) {
      if (error instanceof ZodError) {
        const failure = new ScrapeFailure({
          code: 'invalid_request',
          domain,
          stage: 'request',
          message: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ') || 'Invalid request',
        });
        request.log.warn(scrapeLogFields(failure, domain), 'scrape failed');
        return reply.code(failure.httpStatus()).send(failure.toBody());
      }
      throw error;
    }

    try {
      const result = await orchestrator.scrape(body.domain, body.detailLimit);
      return result;
    } catch (error) {
      const normalized = error instanceof ZodError
        ? new ScrapeFailure({
            code: 'extractor_failed',
            reason: 'extractor_parse',
            retryable: false,
            domain: body.domain,
            stage: 'extract',
            message: 'Extractor response did not match the schema',
          })
        : error;
      const mapped = scrapeErrorResponse(normalized, body.domain);
      const log = mapped.status >= 500 ? request.log.error.bind(request.log) : request.log.warn.bind(request.log);
      log(scrapeLogFields(normalized, body.domain), 'scrape failed');
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  fastify.get('/health', async () => {
    return { status: 'ok' };
  });
}
