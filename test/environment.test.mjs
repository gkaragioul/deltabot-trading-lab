import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

test('local RPC settings load from the project and explicit process settings take precedence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-env-'));
  try {
    writeFileSync(join(dir, '.env.local'), 'SOLANA_RPC_URL=https://local.example/rpc\n');
    const code = `import { loadLocalEnvironment } from ${JSON.stringify(pathToFileURL(resolve('src/environment.mjs')).href)};
      loadLocalEnvironment(${JSON.stringify(dir)}); console.log(process.env.SOLANA_RPC_URL);`;
    const env = { ...process.env }; delete env.SOLANA_RPC_URL;
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' }).trim(), 'https://local.example/rpc');
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...env, SOLANA_RPC_URL: 'https://explicit.example/rpc' }, encoding: 'utf8' }).trim(), 'https://explicit.example/rpc');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
