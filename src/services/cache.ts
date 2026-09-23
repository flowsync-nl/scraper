import { Redis } from 'ioredis';
import { createHash } from 'crypto';
import { redactSecrets } from './scrape-failure';

export class CacheService {
  private redis: Redis | null = null;
  private memoryCache: Map<string, { data: unknown; expires: number }> = new Map();
  private ttl = 24 * 60 * 60; // 24 hours

  constructor(redisUrl?: string) {
    if (redisUrl) {
      this.redis = new Redis(redisUrl);
      // Without a listener, ioredis emits `error` and can crash the process.
      this.redis.on('error', (err: Error) => {
        const message = err?.message ? redactSecrets(err.message) : 'unknown redis error';
        console.error(`Redis cache error: ${message}`);
      });
    }
  }

  /** Success payloads use `vacancy:` + 16 hex chars. Not for blocks, timeouts, or extractor failures. */
  keyFor(domain: string): string {
    return `vacancy:${this.hash(domain)}`;
  }

  /** Short lock so a repeated block does not launch Chromium on every poll. */
  blockKeyFor(domain: string): string {
    return `vacancy-block:${this.hash(domain)}`;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 16);
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.redis) {
      try {
        const data = await this.redis.get(key);
        return data ? JSON.parse(data) : null;
      } catch {
        return null;
      }
    }

    const cached = this.memoryCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.data as T;
    }
    this.memoryCache.delete(key);
    return null;
  }

  async set<T>(key: string, data: T, ttl?: number): Promise<void> {
    const expiry = ttl ?? this.ttl;

    if (this.redis) {
      try {
        await this.redis.setex(key, expiry, JSON.stringify(data));
        return;
      } catch {
        // Fall through to memory cache on Redis error
      }
    }
    this.memoryCache.set(key, {
      data,
      expires: Date.now() + expiry * 1000,
    });
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}
