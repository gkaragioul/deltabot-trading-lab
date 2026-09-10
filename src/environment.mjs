import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadLocalEnvironment(root) {
  const path = join(root, '.env.local');
  if (existsSync(path)) process.loadEnvFile(path);
}
