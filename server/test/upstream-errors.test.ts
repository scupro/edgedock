import { describe, expect, it } from 'vitest';
import { upstreamClientStatus, classifyUpstream } from '../src/lib/errors';
import { ProviderError } from '../src/storage/http';
import { TelegramDriver } from '../src/storage/telegram';

describe('upstream error mapping', () => {
  it('maps provider auth errors to a non-retriable 424, never 401/5xx', () => {
    expect(upstreamClientStatus(401)).toBe(424);
    expect(upstreamClientStatus(403)).toBe(424);
    expect(upstreamClientStatus(400)).toBe(424);
    expect(upstreamClientStatus(404)).toBe(404);
    expect(upstreamClientStatus(413)).toBe(413);
    expect(upstreamClientStatus(500)).toBe(502);
    expect(classifyUpstream(new ProviderError(401, 'x')).retriable).toBe(false);
    expect(classifyUpstream(new ProviderError(429, 'x')).retriable).toBe(true);
  });

  it('reports a truncated Telegram token clearly', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 })) as typeof fetch;
    const d = new TelegramDriver({ botToken: '123:abc', chatId: '-100' }, { fetch: fetchFn } as never);
    const err = await d.test().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/Token 無效/);
  });
});
