// src/index.ts
import 'dotenv/config';
import path from 'path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Orchestrator } from './services/orchestrator';
import { scrapeRoutes } from './routes/scrape';
import { chatsyncRoutes } from './routes/chatsync';
import { googleAdsRoutes } from './routes/google-ads';
import { linkedInAdsRoutes } from './routes/linkedin-ads';
import { customerReviewsRoutes } from './routes/customer-reviews';
import { ChatSyncOrchestrator } from './services/chatsync-orchestrator';
import { GoogleAdsOrchestrator } from './services/google-ads-orchestrator';
import { LinkedInAdsOrchestrator } from './services/linkedin-ads-orchestrator';
import { CustomerReviewsOrchestrator } from './services/customer-reviews-orchestrator';
import { CacheService } from './services/cache';
import { ScraperService } from './services/scraper';
import { DiscoveryService } from './services/discovery';

async function main() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  await fastify.register(cors, {
    origin: true,
  });

  // Serve static files (frontend)
  await fastify.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/',
  });

  // Validate required env vars
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  const orchestrator = new Orchestrator({
    redisUrl: process.env.REDIS_URL,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  });

  // ChatSync dependencies
  const cache = new CacheService(process.env.REDIS_URL);
  const scraper = new ScraperService();
  const discovery = new DiscoveryService(scraper);
  const chatsyncOrchestrator = new ChatSyncOrchestrator(cache, scraper, discovery);
  const googleAdsOrchestrator = new GoogleAdsOrchestrator(cache);
  const linkedInAdsOrchestrator = new LinkedInAdsOrchestrator(cache, scraper);
  const customerReviewsOrchestrator = new CustomerReviewsOrchestrator(cache, scraper);

  // Register routes
  await scrapeRoutes(fastify, orchestrator);
  await chatsyncRoutes(fastify, chatsyncOrchestrator);
  await googleAdsRoutes(fastify, googleAdsOrchestrator);
  await linkedInAdsRoutes(fastify, linkedInAdsOrchestrator);
  await customerReviewsRoutes(fastify, customerReviewsOrchestrator);

  // Serve docs page
  fastify.get('/docs', async (request, reply) => {
    return reply.sendFile('docs.html');
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await orchestrator.close();
    await cache.close();
    await scraper.close();
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start server
  const port = parseInt(process.env.PORT || '3000', 10);

  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${port}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();
