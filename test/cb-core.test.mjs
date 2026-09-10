import test from 'node:test';
import assert from 'node:assert/strict';
import { d, f, mul, div, floorStep, ceilStep } from '../src/cb/decimal.mjs';
import { settings } from '../src/cb/config.mjs';
import { CoinbaseApi } from '../src/cb/api.mjs';
import { generateKeyPairSync } from 'node:crypto';
const pair = generateKeyPairSync('ec', {namedCurve:'prime256v1'});
const key = {name:'organizations/test/apiKeys/test', privateKey:pair.privateKey.export({type:'sec1',format:'pem'})};
test('decimal arithmetic never rounds order sizes upward or loses small token precision', () => {
  assert.equal(f(d('0.1') + d('0.2')), '0.3');
  assert.equal(f(mul(d('12345678.12345678'), d('0.00000001'))), '0.1234567812345678');
  assert.equal(f(floorStep(d('0.123456'),d('0.001'))),'0.123');
  assert.equal(f(ceilStep(d('0.123456'),d('0.001'))),'0.124');
  assert.equal(f(div(d('5'),d('3'))),'1.666666666666666666');
  for(const v of ['NaN','1e-8','',null,'0.0000000000000000001']) assert.throws(()=>d(v));
});
test('Coinbase trial limits cannot be bypassed through config overrides', () => {
  for(const change of [{activeUsd:100},{positionUsd:20},{maxPositions:3},{maxOrdersPerDay:500},{pollSeconds:0},{quote:'USD'},{maxDailyLossUsd:30},{surprise:1}]) assert.throws(()=>settings(change));
  assert.equal(settings().maxOrdersPerDay,200);
});
test('Coinbase mutations default disabled, endpoints restricted and JWT is method-bound', async () => {
  let count=0;
  const api=new CoinbaseApi(key,{fetchFn:async(url,o)=>{count++;const payload=JSON.parse(Buffer.from(o.headers.Authorization.split(' ')[1].split('.')[1],'base64url'));assert.equal(payload.uri,'POST api.coinbase.com/api/v3/brokerage/orders/preview');return new Response('{}');},paceMs:0});
  await api.preview({});
  await assert.rejects(api.submit({}),/LIVE_SUBMISSION_DISABLED/);
  await assert.rejects(api.request('GET','/api/v3/brokerage/transfers'),/ENDPOINT_NOT_ALLOWED/);
  await assert.rejects(api.request('POST','/api/v3/brokerage/orders',{}),/LIVE_SUBMISSION_DISABLED/);
  assert.equal(count,1);
});
