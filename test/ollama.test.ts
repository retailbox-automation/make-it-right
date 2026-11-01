import { describe, expect, it } from 'vitest';
import { OllamaVisionModel } from '../src/models/ollama.js';
import { ModelError } from '../src/models/vision.js';

type Call = { url: string; body: Record<string, any> };

function fakeFetch(replies: Array<{ status?: number; body: string } | Error | 'hang'>) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const r = queue.shift();
    if (!r) throw new Error('fake fetch: no reply queued');
    if (r instanceof Error) throw r;
    if (r === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return new Response(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const chat = (content: string) => ({ body: JSON.stringify({ message: { role: 'assistant', content }, done: true }) });
const REQ = { system: 'sys', prompt: 'hello', schema: { type: 'object' } };

describe('OllamaVisionModel', () => {
  it('sends a non-streaming chat with the schema, temperature 0, no thinking and an explicit num_ctx', async () => {
    const f = fakeFetch([chat('{"ok":true}')]);
    const m = new OllamaVisionModel({ fetch: f.fn });
    const r = await m.json<{ ok: boolean }>({ ...REQ, images: [Buffer.from('abc')], maxTokens: 512 });
    expect(r.value).toEqual({ ok: true });
    expect(r.raw).toBe('{"ok":true}');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(m.name).toBe('gemma4:31b');
    expect(f.calls[0]!.url).toBe('http://localhost:11434/api/chat');
    expect(f.calls[0]!.body).toEqual({
      model: 'gemma4:31b',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello', images: [Buffer.from('abc').toString('base64')] },
      ],
      stream: false,
      think: false,
      format: { type: 'object' },
      options: { temperature: 0, num_ctx: 16384, num_predict: 512 },
    });
  });

  it('uses the given base URL, model and num_ctx; no images key without images', async () => {
    const f = fakeFetch([chat('{}')]);
    await new OllamaVisionModel({ fetch: f.fn, baseUrl: 'http://studio:11434/', model: 'gemma4:26b', numCtx: 8192 }).json(REQ);
    expect(f.calls[0]!.url).toBe('http://studio:11434/api/chat');
    expect(f.calls[0]!.body.model).toBe('gemma4:26b');
    expect(f.calls[0]!.body.options).toEqual({ temperature: 0, num_ctx: 8192 });
    expect(f.calls[0]!.body.messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('retries once on invalid JSON', async () => {
    const f = fakeFetch([chat('{"items": ['), chat('{"items": []}')]);
    const r = await new OllamaVisionModel({ fetch: f.fn }).json(REQ);
    expect(r.value).toEqual({ items: [] });
    expect(f.calls).toHaveLength(2);
  });

  it('invalid JSON twice is an invalid_json failure carrying the raw answer', async () => {
    const f = fakeFetch([chat('nope'), chat('still nope')]);
    const err = await new OllamaVisionModel({ fetch: f.fn }).json(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.kind).toBe('invalid_json');
    expect(err.raw).toBe('still nope');
    expect(f.calls).toHaveLength(2);
  });

  it('an HTTP error is an http failure, not retried', async () => {
    const f = fakeFetch([{ status: 500, body: '{"error":"model not found"}' }]);
    const err = await new OllamaVisionModel({ fetch: f.fn }).json(REQ).catch((e) => e);
    expect(err.kind).toBe('http');
    expect(err.message).toContain('500');
    expect(err.message).toContain('model not found');
    expect(f.calls).toHaveLength(1);
  });

  it('a reply without message content is an http failure', async () => {
    const f = fakeFetch([{ body: '{"done":true}' }]);
    await expect(new OllamaVisionModel({ fetch: f.fn }).json(REQ)).rejects.toMatchObject({ kind: 'http' });
  });

  it('times out with AbortController', async () => {
    const f = fakeFetch(['hang']);
    const err = await new OllamaVisionModel({ fetch: f.fn, timeoutMs: 20 }).json(REQ).catch((e) => e);
    expect(err.kind).toBe('timeout');
  });

  it('an unreachable server is a network failure', async () => {
    const f = fakeFetch([new TypeError('fetch failed')]);
    await expect(new OllamaVisionModel({ fetch: f.fn }).json(REQ)).rejects.toMatchObject({ kind: 'network' });
  });

  it('rejects a num_ctx that is not set sensibly', () => {
    expect(() => new OllamaVisionModel({ numCtx: 0 })).toThrow(/num_ctx/);
    expect(() => new OllamaVisionModel({ numCtx: 2048.5 })).toThrow(/num_ctx/);
    expect(() => new OllamaVisionModel({ timeoutMs: 0 })).toThrow(/timeout/);
  });
});
