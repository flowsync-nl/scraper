import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CacheService } from '../cache';

const { redisOn } = vi.hoisted(() => ({ redisOn: vi.fn() }));

vi.mock('ioredis', () => ({
  Redis: class {
    constructor(_url?: string) {}
    on(event: string, cb: (...args: unknown[]) => void) {
      redisOn(event, cb);
      return this;
    }
    quit() {
      return Promise.resolve('OK');
    }
    get() {
      return Promise.resolve(null);
    }
    setex() {
      return Promise.resolve('OK');
    }
  },
}));

describe('CacheService', () => {
  let cache: CacheService;

  beforeEach(() => {
    cache = new CacheService();
  });

  it('should return null for cache miss', async () => {
    const result = await cache.get('nonexistent');
    expect(result).toBeNull();
  });

  it('should return cached value for cache hit', async () => {
    const data = { domain: 'test.nl', hasVacancies: true };
    await cache.set('test-key', data, 3600);
    const result = await cache.get('test-key');
    expect(result).toEqual(data);
  });

  it('should generate consistent cache key from domain', () => {
    const key1 = cache.keyFor('example.nl');
    const key2 = cache.keyFor('example.nl');
    const key3 = cache.keyFor('other.nl');
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('uses a separate key for a block lock', () => {
    expect(cache.blockKeyFor('bas-hr.nl')).toMatch(/^vacancy-block:[a-f0-9]{16}$/);
    expect(cache.blockKeyFor('bas-hr.nl')).not.toBe(cache.keyFor('bas-hr.nl'));
    expect(cache.keyFor('bas-hr.nl')).toMatch(/^vacancy:[a-f0-9]{16}$/);
  });

  it('attaches an error listener when a redis url is set', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const redisCache = new CacheService('redis://:secret@localhost:6379');
    expect(redisOn).toHaveBeenCalledWith('error', expect.any(Function));
    const handler = redisOn.mock.calls.find((call) => call[0] === 'error')?.[1] as (err: Error) => void;
    expect(() => handler(new Error('connect ECONNREFUSED redis://:secret@localhost:6379'))).not.toThrow();
    expect(String(spy.mock.calls.at(-1)?.[0])).not.toContain('secret');
    await redisCache.close();
    spy.mockRestore();
  });
});
