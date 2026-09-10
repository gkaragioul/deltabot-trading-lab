import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { CoinbaseConnection, createJwt } from '../src/coinbase.mjs';

const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credentials = { name: 'organizations/fixture/apiKeys/fixture',
  privateKey: pair.privateKey.export({ type: 'sec1', format: 'pem' }) };

test('Coinbase authentication signs a short-lived request-bound ES256 token', () => {
  const jwt = createJwt(credentials, '/api/v3/brokerage/accounts', 1000);
  const [header, payload, signature] = jwt.split('.');
  const h = JSON.parse(Buffer.from(header, 'base64url')); const p = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(h.alg, 'ES256'); assert.equal(h.kid, credentials.name);
  assert.equal(p.sub, credentials.name); assert.equal(p.iss, 'cdp');
  assert.equal(p.nbf, 1000); assert.equal(p.exp, 1120);
  assert.equal(p.uri, 'GET api.coinbase.com/api/v3/brokerage/accounts');
  assert.ok(verify('sha256', Buffer.from(header + '.' + payload),
    { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.notEqual(jwt, createJwt(credentials, '/api/v3/brokerage/accounts', 1000));
});

test('connection only sends GET requests to the allowed Coinbase read endpoints', async () => {
  let calls = 0;
  const client = new CoinbaseConnection(credentials, { fetchFn: async (url, options) => {
    calls++; assert.equal(new URL(url).origin, 'https://api.coinbase.com');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.match(options.headers.Authorization, /^Bearer /);
    return new Response('{}');
  } });
  await client.get('/api/v3/brokerage/key_permissions');
  for (const path of ['https://evil.example', '//evil.example', '/api/v3/brokerage/orders', '/api/v3/brokerage/accounts/../orders']) {
    await assert.rejects(client.get(path), /READ_ENDPOINT_NOT_ALLOWED/);
  }
  assert.equal(calls, 1);
});

test('account pagination preserves all pages and refuses repeated cursors', async () => {
  const client = new CoinbaseConnection(credentials); let n = 0;
  client.get = async () => ++n === 1 ? { accounts: [{ currency: 'USDC' }], has_next: true, cursor: 'next' }
    : { accounts: [{ currency: 'SOL' }], has_next: false };
  assert.equal((await client.accounts()).length, 2);
  client.get = async () => ({ accounts: [], has_next: true, cursor: 'same' });
  await assert.rejects(client.accounts(), /INVALID_ACCOUNT_PAGINATION/);
});

test('Coinbase HTTP errors do not expose credentials or response bodies', async () => {
  const client = new CoinbaseConnection(credentials, { fetchFn: async () => new Response('sensitive response', { status: 401 }) });
  await assert.rejects(client.get('/api/v3/brokerage/accounts'), { message: 'COINBASE_HTTP_401' });
});
