import {homedir} from 'node:os';
import {join} from 'node:path';
// One live Coinbase worker per OS user, across runtimes and cloned checkouts.
export const liveLockPath=join(homedir(),'.deltabot','coinbase-live-account');
export function requestStop(db,abort){db.command('stop');abort.abort();}
