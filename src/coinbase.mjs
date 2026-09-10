import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnvironment } from './environment.mjs';

const base = '/api/v3/brokerage';
const allowed = new Set([`${base}/accounts`, `${base}/key_permissions`]);

export function createJwt(credentials, path, seconds = Math.floor(Date.now() / 1000)) {
  if (!allowed.has(path)) throw new Error('READ_ENDPOINT_NOT_ALLOWED');
  return signCoinbaseRequest(credentials, 'GET', path, seconds);
}

export function signCoinbaseRequest(credentials, method, path, seconds = Math.floor(Date.now() / 1000)) {
  if (!['GET', 'POST'].includes(method) || !/^\/api\/v3\/brokerage\/[a-zA-Z0-9_/-]+$/.test(path) || path.includes('..')) throw new Error('INVALID_REQUEST_TARGET');
  let key;
  try {
    if (typeof credentials.name !== 'string' || !/^organizations\/[^/\s]+\/apiKeys\/[^/\s]+$/.test(credentials.name)) throw new Error();
    key = createPrivateKey(credentials.privateKey);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
  } catch { throw new Error('INVALID_COINBASE_CREDENTIALS'); }
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'ES256', typ: 'JWT', kid: credentials.name, nonce: randomBytes(16).toString('hex') });
  const payload = encode({ sub: credentials.name, iss: 'cdp', nbf: seconds, exp: seconds + 120, uri: `${method} api.coinbase.com${path}` });
  const message = `${header}.${payload}`;
  return `${message}.${sign('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

// Connection verification only. This module has no order or transfer operation.
export class CoinbaseConnection {
  constructor(credentials, { fetchFn = fetch } = {}) {
    this.credentials = credentials; this.fetch = fetchFn;
  }
  async get(path, params = {}) {
    if (!allowed.has(path)) throw new Error('READ_ENDPOINT_NOT_ALLOWED');
    const query = new URLSearchParams(params).toString();
    const jwt = createJwt(this.credentials, path);
    let response;
    try {
      response = await this.fetch(`https://api.coinbase.com${path}${query ? '?' + query : ''}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' } });
    } catch { throw new Error('COINBASE_NETWORK_UNAVAILABLE'); }
    if (!response.ok) throw new Error(`COINBASE_HTTP_${response.status}`);
    const body = await response.text();
    if (body.length > 4_000_000) throw new Error('COINBASE_RESPONSE_TOO_LARGE');
    try { return JSON.parse(body); } catch { throw new Error('COINBASE_INVALID_JSON'); }
  }
  async accounts() {
    const accounts = []; const seen = new Set(); let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.get(`${base}/accounts`, { limit: '250', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.accounts) || typeof result.has_next !== 'boolean') throw new Error('INVALID_ACCOUNT_RESPONSE');
      accounts.push(...result.accounts);
      if (!result.has_next) return accounts;
      if (typeof result.cursor !== 'string' || !result.cursor || seen.has(result.cursor)) throw new Error('INVALID_ACCOUNT_PAGINATION');
      cursor = result.cursor; seen.add(cursor);
    }
    throw new Error('ACCOUNT_PAGINATION_LIMIT');
  }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  loadLocalEnvironment(root);
  if (!process.env.COINBASE_KEY_FILE) throw new Error('COINBASE_KEY_FILE_REQUIRED');
  let credentials;
  try { credentials = JSON.parse(readFileSync(process.env.COINBASE_KEY_FILE, 'utf8')); }
  catch { throw new Error('COINBASE_KEY_FILE_UNREADABLE'); }
  const client = new CoinbaseConnection(credentials);
  const permissions = await client.get(`${base}/key_permissions`);
  if (permissions.can_view !== true || typeof permissions.can_trade !== 'boolean' || typeof permissions.can_transfer !== 'boolean') throw new Error('INVALID_COINBASE_PERMISSIONS');
  if (permissions.can_transfer) throw new Error('COINBASE_TRANSFER_PERMISSION_MUST_BE_DISABLED');
  const accounts = await client.accounts();
  const balances = accounts.filter(a => Number(a.available_balance?.value) > 0 || Number(a.hold?.value) > 0)
    .map(a => ({ currency: a.currency, available: a.available_balance.value, held: a.hold?.value ?? '0' }));
  const summary = { checkedAt: new Date().toISOString(), connected: true,
    permissions: { view: permissions.can_view, trade: permissions.can_trade, transfer: permissions.can_transfer },
    balances, accountCount: accounts.length, automatedTrading: false };
  const runtime = join(root, 'runtime', 'coinbase'); mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'connection.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = String(error?.message ?? '');
    console.error(/^[A-Z0-9_]+$/.test(message) ? message : 'COINBASE_CONNECTION_FAILED');
    process.exitCode = 1;
  });
}
