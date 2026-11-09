// tools/docker-entrypoint.sh with a stand-in `infisical` on PATH: no vault is called.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../tools/docker-entrypoint.sh', import.meta.url));
const bin = mkdtempSync(join(tmpdir(), 'mir-entry-'));
afterAll(() => rmSync(bin, { recursive: true, force: true }));

// login prints a token unless FAKE_LOGIN=fail; export prints FAKE_EXPORT; run records its flags and runs the command with one secret set
writeFileSync(
  join(bin, 'infisical'),
  `#!/bin/sh
case "$1" in
  login) [ "\${FAKE_LOGIN:-ok}" = ok ] && echo "token-from-login" || exit 1 ;;
  export) printf '%s' "$FAKE_EXPORT" ;;
  run) shift; flags=""; while [ "$1" != "--" ]; do flags="$flags $1"; shift; done; shift
       echo "infisical run:$flags token=$INFISICAL_TOKEN" >&2
       PAYPAL_SANDBOX_CLIENT_ID=from-vault exec "$@" ;;
  *) exit 2 ;;
esac
`,
);
chmodSync(join(bin, 'infisical'), 0o755);

const SECRET_VALUE = 'sb-secret-value-9f3a';
const vault = (secrets: Record<string, string>) => JSON.stringify(Object.entries(secrets).map(([key, value]) => ({ key, value, type: 'shared' })));
const GOOD = vault({ PAYPAL_SANDBOX_CLIENT_ID: 'AbC-id', PAYPAL_SANDBOX_CLIENT_SECRET: SECRET_VALUE, MIR_PUBLIC_DEMO: '1' });
const IDENTITY = {
  INFISICAL_API_URL: 'https://vault.example/api',
  INFISICAL_PROJECT_ID: 'proj-1',
  INFISICAL_SECRET_PATH: '/make-it-right',
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: 'client-id-1',
  INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: 'identity-secret-7c1d',
};

function run(env: Record<string, string>) {
  const result = spawnSync('sh', [SCRIPT, 'sh', '-c', 'echo "app ran with $PAYPAL_SANDBOX_CLIENT_ID"'], {
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, ...env },
    encoding: 'utf8',
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe.skipIf(asRoot)('the container entrypoint', () => {
  it('starts the app under `infisical run` with the folder of this service, logging names and a count only', () => {
    const { code, out, err } = run({ ...IDENTITY, FAKE_EXPORT: GOOD, INFISICAL_TOKEN: 'inherited-token' });
    expect(code).toBe(0);
    expect(out).toBe('app ran with from-vault\n');
    expect(err).toContain('infisical run: --projectId=proj-1 --env=prod --path=/make-it-right token=token-from-login');
    expect(err).toContain('3 secrets at /make-it-right (env prod): MIR_PUBLIC_DEMO, PAYPAL_SANDBOX_CLIENT_ID, PAYPAL_SANDBOX_CLIENT_SECRET; starting the app');
    for (const value of [SECRET_VALUE, 'AbC-id', 'identity-secret-7c1d', 'inherited-token']) expect(err).not.toContain(value);
  });

  it('is fail-closed by default: without SECRETS_SOURCE it still needs the vault', () => {
    const { code, err, out } = run({ FAKE_EXPORT: GOOD });
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('needs these variables, which are unset or empty: INFISICAL_API_URL INFISICAL_PROJECT_ID INFISICAL_SECRET_PATH INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET');
  });

  it('names each missing variable', () => {
    const { INFISICAL_SECRET_PATH: _path, ...rest } = IDENTITY;
    const { code, err } = run({ ...rest, INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: '', FAKE_EXPORT: GOOD });
    expect(code).toBe(1);
    expect(err).toMatch(/unset or empty: INFISICAL_SECRET_PATH INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET$/m);
  });

  it('refuses to start when the login fails', () => {
    const { code, err, out } = run({ ...IDENTITY, FAKE_LOGIN: 'fail', FAKE_EXPORT: GOOD });
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('login to https://vault.example/api failed');
  });

  it.each([
    ['an empty secret set', '[]', /no secrets at \/make-it-right \(env prod\); refusing to start/],
    ['an answer that is not a list', '{"key":"PAYPAL_SANDBOX_CLIENT_ID"}', /could not read the secrets/],
    ['an answer that is not JSON', 'Error: token expired', /could not read the secrets/],
    ['entries without a name', '[{"value":"x"}]', /could not read the secrets/],
    ['a set without the PayPal credentials', vault({ OTHER: 'x' }), /lack: PAYPAL_SANDBOX_CLIENT_ID, PAYPAL_SANDBOX_CLIENT_SECRET/],
    ['a set without the client secret', vault({ PAYPAL_SANDBOX_CLIENT_ID: 'x' }), /lack: PAYPAL_SANDBOX_CLIENT_SECRET$/m],
  ])('refuses to start on %s', (_what, answer, message) => {
    const { code, err, out } = run({ ...IDENTITY, FAKE_EXPORT: answer });
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toMatch(message);
  });

  it('takes another environment slug when given', () => {
    const { code, err } = run({ ...IDENTITY, INFISICAL_ENV: 'staging', FAKE_EXPORT: GOOD });
    expect(code).toBe(0);
    expect(err).toContain('--env=staging');
  });

  it('runs the app as it is with SECRETS_SOURCE=platform, and refuses an unknown source', () => {
    const platform = run({ SECRETS_SOURCE: 'platform', PAYPAL_SANDBOX_CLIENT_ID: 'from-host' });
    expect(platform.code).toBe(0);
    expect(platform.out).toBe('app ran with from-host\n');
    const unknown = run({ SECRETS_SOURCE: 'files' });
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("SECRETS_SOURCE must be infisical or platform, not 'files'");
  });

  it('drops root before anything else, and the image runs it as its entrypoint with the app as the command', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script.indexOf('setpriv --reuid="$APP_USER"')).toBeGreaterThan(0);
    expect(script.indexOf('setpriv --reuid="$APP_USER"')).toBeLessThan(script.indexOf('SECRETS_SOURCE="${SECRETS_SOURCE:-infisical}"'));
    const dockerfile = readFileSync(fileURLToPath(new URL('../Dockerfile', import.meta.url)), 'utf8');
    expect(dockerfile).toContain('FROM public.ecr.aws/docker/library/node:22-bookworm-slim');
    expect(dockerfile).toContain('npm ci --omit=dev');
    expect(dockerfile).toMatch(/MIR_DATA_DIR=\/data/);
    expect(dockerfile).toMatch(/PORT=8080/);
    expect(dockerfile).toContain('sha256sum -c -');
    expect(dockerfile).toContain('ENTRYPOINT ["/app/docker-entrypoint.sh"]');
    expect(dockerfile).not.toMatch(/^USER /m);
  });
});
