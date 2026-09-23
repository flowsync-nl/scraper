import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIExtractor, DEFAULT_ANTHROPIC_MODEL } from '../ai-extractor';

describe('AIExtractor', () => {
  it('should build correct prompt', () => {
    const extractor = new AIExtractor('test-key');
    const prompt = extractor.buildPrompt('<html><body>Jobs page</body></html>', 'https://example.nl/careers');

    expect(prompt).toContain('JSON');
    expect(prompt).toContain('vacatures');
    expect(prompt).toContain('example.nl');
  });

  it('should clean HTML before sending', () => {
    const extractor = new AIExtractor('test-key');
    const html = `
      <html>
        <head><script>var x = 1;</script><style>.a{}</style></head>
        <body><div class="job">Developer</div></body>
      </html>
    `;
    const cleaned = extractor.cleanHtml(html);

    expect(cleaned).not.toContain('<script>');
    expect(cleaned).not.toContain('<style>');
    expect(cleaned).toContain('Developer');
  });

  const careerHtml = `<html><body><h1>Vacatures</h1><p>${'We are hiring a developer. '.repeat(10)}</p></body></html>`;

  function client(create: ReturnType<typeof vi.fn>) {
    return { messages: { create } } as unknown as ConstructorParameters<typeof AIExtractor>[1];
  }

  afterEach(() => {
    delete process.env.ANTHROPIC_MODEL;
  });

  it('uses ANTHROPIC_MODEL and otherwise the current Haiku id', async () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(DEFAULT_ANTHROPIC_MODEL).not.toContain('20241022');

    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"vacancies":[],"confidence":0.5}' }],
    });
    delete process.env.ANTHROPIC_MODEL;
    await new AIExtractor('test-key', client(create)).extract(careerHtml, 'https://example.nl/careers');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].model).toBe(DEFAULT_ANTHROPIC_MODEL);

    process.env.ANTHROPIC_MODEL = 'claude-test-model';
    await new AIExtractor('test-key', client(create)).extract(careerHtml, 'https://example.nl/careers');
    expect(create.mock.calls[1][0].model).toBe('claude-test-model');
  });

  it('does not send challenge HTML to the model', async () => {
    const create = vi.fn();
    const html = '<html><head><script src="/.well-known/sgcaptcha/"></script></head><body>sgcaptcha</body></html>';
    await expect(new AIExtractor('test-key', client(create)).extract(html, 'https://bas-hr.nl/vacatures'))
      .rejects.toMatchObject({ code: 'blocked', retryable: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not retry a model 404 and retries provider 429 once', async () => {
    const missing = Object.assign(new Error('model: claude-3-5-haiku-20241022'), {
      status: 404,
      error: { type: 'not_found_error', message: 'not found' },
    });
    const create = vi.fn().mockRejectedValue(missing);
    await expect(new AIExtractor('test-key', client(create)).extract(careerHtml, 'https://example.nl/careers'))
      .rejects.toMatchObject({ code: 'extractor_failed', reason: 'model_unavailable', retryable: false });
    expect(create).toHaveBeenCalledTimes(1);

    const limited = Object.assign(new Error('rate limited'), { status: 429, error: { type: 'rate_limit_error' } });
    const retry = vi.fn().mockRejectedValue(limited);
    await expect(new AIExtractor('test-key', client(retry)).extract(careerHtml, 'https://example.nl/careers'))
      .rejects.toMatchObject({ code: 'extractor_failed', reason: 'rate_limited', retryable: true });
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('wraps a schema mismatch as extractor_parse without a second model call', async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'not json' }] });
    await expect(new AIExtractor('test-key', client(create)).extract(careerHtml, 'https://example.nl/careers'))
      .rejects.toMatchObject({ code: 'extractor_failed', reason: 'extractor_parse', retryable: false });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
