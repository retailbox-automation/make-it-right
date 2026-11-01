// VisionModel over Ollama's /api/chat (local models only).
import { ModelError, type VisionModel, type VisionRequest } from './vision.js';

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  /** Context window. Always sent: Ollama's own default can be far larger than needed (262144 on 0.40.13). */
  numCtx?: number;
  /** Per attempt */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface ChatResponse {
  message?: { content?: unknown };
  done_reason?: string;
}

export class OllamaVisionModel implements VisionModel {
  readonly name: string;
  readonly baseUrl: string;
  readonly numCtx: number;
  readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: OllamaOptions = {}) {
    this.name = opts.model ?? 'gemma4:31b';
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.numCtx = opts.numCtx ?? 16384;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.fetchFn = opts.fetch ?? fetch;
    if (!Number.isInteger(this.numCtx) || this.numCtx < 1024) throw new Error(`num_ctx must be a whole number ≥ 1024, got ${this.numCtx}`);
    if (!(this.timeoutMs > 0)) throw new Error(`timeout must be positive, got ${this.timeoutMs}`);
  }

  async json<T>(req: VisionRequest): Promise<{ value: T; ms: number; raw: string }> {
    const body = JSON.stringify({
      model: this.name,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.prompt, ...(req.images?.length ? { images: req.images.map((b) => b.toString('base64')) } : {}) },
      ],
      stream: false,
      think: false,
      format: req.schema,
      options: { temperature: 0, num_ctx: this.numCtx, ...(req.maxTokens ? { num_predict: req.maxTokens } : {}) },
    });
    const started = performance.now();
    let raw = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      raw = await this.post(body);
      try {
        const value = JSON.parse(raw) as T;
        return { value, ms: Math.round(performance.now() - started), raw };
      } catch {
        // one retry on invalid JSON, then give up
      }
    }
    throw new ModelError('invalid_json', `${this.name}: answer is not JSON after 2 attempts`, raw);
  }

  private async post(body: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: ctrl.signal,
        });
      } catch (e) {
        if (ctrl.signal.aborted) throw new ModelError('timeout', `${this.name}: no answer in ${this.timeoutMs} ms`);
        throw new ModelError('network', `${this.name}: ${this.baseUrl} unreachable: ${(e as Error).message}`);
      }
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        if (ctrl.signal.aborted) throw new ModelError('timeout', `${this.name}: no answer in ${this.timeoutMs} ms`);
        throw new ModelError('network', `${this.name}: reading the answer failed: ${(e as Error).message}`);
      }
      if (!res.ok) throw new ModelError('http', `${this.name}: HTTP ${res.status}: ${text.slice(0, 300)}`, text);
      let data: ChatResponse;
      try {
        data = JSON.parse(text) as ChatResponse;
      } catch {
        throw new ModelError('http', `${this.name}: server answer is not JSON: ${text.slice(0, 300)}`, text);
      }
      const content = data.message?.content;
      if (typeof content !== 'string') throw new ModelError('http', `${this.name}: answer has no message content`, text);
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
