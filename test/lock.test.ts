import { describe, expect, it } from 'vitest';
import { KeyedLock } from '../src/lock.js';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedLock', () => {
  it('runs jobs of one key one after another, in order', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`${name} start`);
      await pause(ms);
      log.push(`${name} end`);
    };
    await Promise.all([lock.run('a', job('1', 20)), lock.run('a', job('2', 1)), lock.run('a', job('3', 1))]);
    expect(log).toEqual(['1 start', '1 end', '2 start', '2 end', '3 start', '3 end']);
  });

  it('lets different keys run together', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    await Promise.all([
      lock.run('a', async () => { log.push('a start'); await pause(20); log.push('a end'); }),
      lock.run('b', async () => { log.push('b start'); await pause(1); log.push('b end'); }),
    ]);
    expect(log).toEqual(['a start', 'b start', 'b end', 'a end']);
  });

  it('keeps going after a job fails, and passes the failure to its caller only', async () => {
    const lock = new KeyedLock();
    const failing = lock.run('a', async () => { throw new Error('boom'); });
    const next = lock.run('a', async () => 'fine');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('fine');
  });
});
