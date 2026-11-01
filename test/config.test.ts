import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const creds = { PAYPAL_SANDBOX_CLIENT_ID: 'id', PAYPAL_SANDBOX_CLIENT_SECRET: 'secret' };

describe('loadConfig', () => {
  it('uses sensible defaults', () => {
    expect(loadConfig(creds)).toEqual({
      port: 8787, dataDir: './data', clientId: 'id', clientSecret: 'secret',
      returnUrl: 'http://localhost:8787/paypal/return', cancelUrl: 'http://localhost:8787/paypal/cancel',
      pollSeconds: null, journalPath: null,
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
});
