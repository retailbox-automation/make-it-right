import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/errors.js';
import { GATE_DEFAULTS, PhotoCheckGate } from '../src/gate.js';

const thrown = (run: () => unknown): HttpError => {
  try {
    run();
  } catch (error) {
    return error as HttpError;
  }
  throw new Error('did not throw');
};

describe('PhotoCheckGate', () => {
  it('has the settings of the brief: 5 checks per client per 10 minutes, one at a time', () => {
    expect(GATE_DEFAULTS).toEqual({ burst: 5, refillMs: 120_000, busyRetrySeconds: 60 });
    expect(GATE_DEFAULTS.burst * GATE_DEFAULTS.refillMs).toBe(10 * 60_000);
  });

  it('lets one check run at a time and turns the next away until the first is left', () => {
    const gate = new PhotoCheckGate({ now: () => 0 });
    const leave = gate.enter('a');
    expect(thrown(() => gate.enter('b'))).toMatchObject({ status: 429, code: 'PHOTO_CHECK_BUSY', headers: { 'retry-after': '60' } });
    leave();
    expect(() => gate.enter('b')).not.toThrow();
  });

  it('leaving twice does not free the place of the check that came after', () => {
    const gate = new PhotoCheckGate({ now: () => 0 });
    const leaveFirst = gate.enter('a');
    leaveFirst();
    gate.enter('b');
    leaveFirst(); // late, and again
    expect(thrown(() => gate.enter('c')).code).toBe('PHOTO_CHECK_BUSY');
  });

  it('gives each client the burst, then one more check per refill period, and says how long to wait', () => {
    let now = 0;
    const gate = new PhotoCheckGate({ burst: 3, refillMs: 60_000, now: () => now });
    for (let i = 0; i < 3; i++) gate.enter('a')();
    expect(thrown(() => gate.enter('a'))).toMatchObject({ status: 429, code: 'RATE_LIMITED', headers: { 'retry-after': '60' } });
    now = 30_000;
    expect(thrown(() => gate.enter('a')).headers).toEqual({ 'retry-after': '30' }); // half a period gone
    now = 60_000;
    gate.enter('a')();
    expect(thrown(() => gate.enter('a')).code).toBe('RATE_LIMITED');
  });

  it('never banks more than the burst, however long a client was away', () => {
    let now = 0;
    const gate = new PhotoCheckGate({ burst: 2, refillMs: 1000, now: () => now });
    gate.enter('a')();
    now = 10_000_000;
    gate.enter('a')();
    gate.enter('a')();
    expect(thrown(() => gate.enter('a')).code).toBe('RATE_LIMITED'); // 2 after the long break, not 3
  });

  it('counts clients apart', () => {
    const gate = new PhotoCheckGate({ burst: 1, now: () => 0 });
    gate.enter('a')();
    expect(thrown(() => gate.enter('a')).code).toBe('RATE_LIMITED');
    expect(() => gate.enter('b')).not.toThrow();
  });

  it('does not use up a client\'s allowance on a check it turned away because another was running', () => {
    const gate = new PhotoCheckGate({ burst: 1, now: () => 0 });
    const leave = gate.enter('a');
    expect(thrown(() => gate.enter('b')).code).toBe('PHOTO_CHECK_BUSY');
    leave();
    expect(() => gate.enter('b')).not.toThrow(); // b still had its one check
  });

  it('forgets clients whose allowance is full again, so the memory does not grow without end', () => {
    let now = 0;
    const gate = new PhotoCheckGate({ burst: 1, refillMs: 1000, now: () => now });
    for (let i = 0; i < 1500; i++) gate.enter(`client-${i}`)();
    now = 5000;
    gate.enter('late')();
    expect((gate as unknown as { clients: Map<string, unknown> }).clients.size).toBeLessThanOrEqual(2);
  });
});
