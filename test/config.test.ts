import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const creds = { PAYPAL_SANDBOX_CLIENT_ID: 'id', PAYPAL_SANDBOX_CLIENT_SECRET: 'secret' };

describe('loadConfig', () => {
  it('uses sensible defaults', () => {
    expect(loadConfig(creds)).toEqual({
      port: 8787, dataDir: './data', clientId: 'id', clientSecret: 'secret',
      returnUrl: 'http://localhost:8787/paypal/return', cancelUrl: 'http://localhost:8787/paypal/cancel',
      pollSeconds: null, journalPath: null, vision: null, uploadQuotaBytes: 2048 * 1024 * 1024, trustForwardedFor: false, publicDemo: null,
    });
  });

  it('reads every setting from the environment', () => {
    const c = loadConfig({ ...creds, PORT: '9000', MIR_DATA_DIR: '/var/mir', MIR_RETURN_URL: 'https://x.example/ok', MIR_CANCEL_URL: 'https://x.example/no', MIR_POLL_SECONDS: '90', MIR_CALL_JOURNAL: '/var/mir/paypal.calls.jsonl' });
    expect(c).toMatchObject({ port: 9000, dataDir: '/var/mir', returnUrl: 'https://x.example/ok', cancelUrl: 'https://x.example/no', pollSeconds: 90, journalPath: '/var/mir/paypal.calls.jsonl' });
  });

  it('lets the system pick a free port with PORT=0', () => {
    expect(loadConfig({ ...creds, PORT: '0' }).port).toBe(0);
  });

  it('builds the default return links from the port', () => {
    expect(loadConfig({ ...creds, PORT: '9000' }).returnUrl).toBe('http://localhost:9000/paypal/return');
  });

  it('names the missing credentials without printing any value', () => {
    expect(() => loadConfig({})).toThrow(/PAYPAL_SANDBOX_CLIENT_ID, PAYPAL_SANDBOX_CLIENT_SECRET/);
    expect(() => loadConfig({ PAYPAL_SANDBOX_CLIENT_ID: 'only-this' })).toThrow(/PAYPAL_SANDBOX_CLIENT_SECRET/);
    try {
      loadConfig({ PAYPAL_SANDBOX_CLIENT_ID: 'only-this' });
    } catch (e) {
      expect(String(e)).not.toContain('only-this');
    }
  });

  it.each([
    [{ PORT: 'abc' }, /PORT/],
    [{ PORT: '-1' }, /PORT/],
    [{ PORT: '8787.5' }, /PORT/],
    [{ PORT: '70000' }, /PORT/],
    [{ MIR_POLL_SECONDS: 'soon' }, /MIR_POLL_SECONDS/],
    [{ MIR_POLL_SECONDS: '5' }, /MIR_POLL_SECONDS/],
  ])('rejects %j', (env, message) => {
    expect(() => loadConfig({ ...creds, ...env })).toThrow(message);
  });

  it('treats an empty optional setting as not set', () => {
    expect(loadConfig({ ...creds, MIR_POLL_SECONDS: '', MIR_CALL_JOURNAL: '', MIR_DATA_DIR: '' })).toMatchObject({ pollSeconds: null, journalPath: null, dataDir: './data' });
  });

  describe('the photo-checking model', () => {
    it('is off unless MIR_VISION_MODEL is set', () => {
      expect(loadConfig(creds).vision).toBeNull();
      expect(loadConfig({ ...creds, MIR_VISION_MODEL: '' }).vision).toBeNull();
      expect(loadConfig({ ...creds, MIR_OLLAMA_URL: 'http://gpu:11434', MIR_NUM_CTX: '8192' }).vision).toBeNull();
    });

    it('takes the model name after "ollama:", with Ollama\'s usual address and an explicit context size', () => {
      expect(loadConfig({ ...creds, MIR_VISION_MODEL: 'ollama:gemma4:31b' }).vision).toEqual({
        provider: 'ollama', model: 'gemma4:31b', baseUrl: 'http://localhost:11434', numCtx: 16384,
      });
    });

    it('reads the address and the context size', () => {
      const vision = loadConfig({ ...creds, MIR_VISION_MODEL: 'ollama:qwen3-vl:8b', MIR_OLLAMA_URL: 'https://gpu.example:11434', MIR_NUM_CTX: '8192' }).vision;
      expect(vision).toEqual({ provider: 'ollama', model: 'qwen3-vl:8b', baseUrl: 'https://gpu.example:11434', numCtx: 8192 });
    });

    it.each([
      [{ MIR_VISION_MODEL: 'gemma4:31b' }, /MIR_VISION_MODEL/],
      [{ MIR_VISION_MODEL: 'openai:gpt-x' }, /MIR_VISION_MODEL/],
      [{ MIR_VISION_MODEL: 'ollama:' }, /MIR_VISION_MODEL/],
      [{ MIR_VISION_MODEL: 'ollama:  ' }, /MIR_VISION_MODEL/],
      [{ MIR_VISION_MODEL: 'ollama:m', MIR_NUM_CTX: 'big' }, /MIR_NUM_CTX/],
      [{ MIR_VISION_MODEL: 'ollama:m', MIR_NUM_CTX: '100' }, /MIR_NUM_CTX/],
      [{ MIR_VISION_MODEL: 'ollama:m', MIR_NUM_CTX: '16384.5' }, /MIR_NUM_CTX/],
      [{ MIR_VISION_MODEL: 'ollama:m', MIR_OLLAMA_URL: 'gpu:11434' }, /MIR_OLLAMA_URL/],
      [{ MIR_VISION_MODEL: 'ollama:m', MIR_OLLAMA_URL: 'ftp://gpu' }, /MIR_OLLAMA_URL/],
      [{ MIR_VISION_MODEL: 'ollama:m', MIR_OLLAMA_URL: 'not a url' }, /MIR_OLLAMA_URL/],
    ])('rejects %j', (env, message) => {
      expect(() => loadConfig({ ...creds, ...env })).toThrow(message);
    });
  });

  describe('limits on uploads and clients', () => {
    it('keeps 2 GB of uploads unless told otherwise, and takes the quota in megabytes', () => {
      expect(loadConfig(creds).uploadQuotaBytes).toBe(2 * 1024 * 1024 * 1024);
      expect(loadConfig({ ...creds, MIR_UPLOADS_QUOTA_MB: '500' }).uploadQuotaBytes).toBe(500 * 1024 * 1024);
      expect(loadConfig({ ...creds, MIR_UPLOADS_QUOTA_MB: '' }).uploadQuotaBytes).toBe(2 * 1024 * 1024 * 1024);
    });

    it.each(['0', '-5', 'lots', '1.5'])('rejects a quota of %j', (value) => {
      expect(() => loadConfig({ ...creds, MIR_UPLOADS_QUOTA_MB: value })).toThrow(/MIR_UPLOADS_QUOTA_MB/);
    });

    it('is not the public demo unless MIR_PUBLIC_DEMO is 1 or true', () => {
      expect(loadConfig(creds).publicDemo).toBeNull();
      expect(loadConfig({ ...creds, MIR_PUBLIC_DEMO: '0' }).publicDemo).toBeNull();
    });

    const host = { ...creds, MIR_PUBLIC_DEMO: '1', MIR_RETURN_URL: 'https://mir.example/paypal/return', MIR_CANCEL_URL: 'https://mir.example/paypal/cancel', MIR_POLL_SECONDS: '60' };

    it('caps new demo cases at 25 per address and 60 in all per day unless told otherwise', () => {
      expect(loadConfig(host).publicDemo).toEqual({ perAddressPerDay: 25, perDay: 60 });
      expect(loadConfig({ ...host, MIR_PUBLIC_DEMO: 'true', MIR_DEMO_CASES_PER_ADDRESS_PER_DAY: '3', MIR_DEMO_CASES_PER_DAY: '9' }).publicDemo).toEqual({ perAddressPerDay: 3, perDay: 9 });
    });

    it.each(['0', '-1', 'many', '2.5'])('rejects a daily cap of %j', (value) => {
      expect(() => loadConfig({ ...host, MIR_DEMO_CASES_PER_DAY: value })).toThrow(/MIR_DEMO_CASES_PER_DAY must be a whole number/);
      expect(() => loadConfig({ ...host, MIR_DEMO_CASES_PER_ADDRESS_PER_DAY: value })).toThrow(/MIR_DEMO_CASES_PER_ADDRESS_PER_DAY must be a whole number/);
    });

    it('refuses to start the public demo without the return addresses or the claim poller', () => {
      const { MIR_RETURN_URL: _r, ...noReturn } = host;
      expect(() => loadConfig(noReturn)).toThrow(/MIR_PUBLIC_DEMO needs MIR_RETURN_URL/);
      expect(() => loadConfig({ ...host, MIR_CANCEL_URL: 'not a url' })).toThrow(/MIR_PUBLIC_DEMO needs MIR_CANCEL_URL/);
      const { MIR_POLL_SECONDS: _p, ...noPoller } = host;
      expect(() => loadConfig(noPoller)).toThrow(/MIR_PUBLIC_DEMO needs MIR_POLL_SECONDS/);
    });

    it('trusts X-Forwarded-For only when asked', () => {
      expect(loadConfig(creds).trustForwardedFor).toBe(false);
      expect(loadConfig({ ...creds, MIR_TRUST_FORWARDED_FOR: '1' }).trustForwardedFor).toBe(true);
      expect(loadConfig({ ...creds, MIR_TRUST_FORWARDED_FOR: 'true' }).trustForwardedFor).toBe(true);
      expect(loadConfig({ ...creds, MIR_TRUST_FORWARDED_FOR: '0' }).trustForwardedFor).toBe(false);
    });
  });
});
