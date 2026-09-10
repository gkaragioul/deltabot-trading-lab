import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configHash, usd } from './config.mjs';

export function initialState(c, mode = 'paper') {
  return { version: 1, mode, configHash: configHash(c), startedAt: Date.now(), cash: usd(c.activeUsd),
    peak: usd(c.activeUsd), realized: 0, positions: {}, history: {}, cooldown: {},
    pending: null, paused: null, lastTick: null, lastError: null, scans: 0, buys: 0, sells: 0,
    latestDecisions: [], lastDiscovery: null, wallet: null };
}

export class Store {
  constructor(dir, c, mode = 'paper') {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'ledger.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1), command TEXT);');
    if (!this.db.prepare('SELECT id FROM state WHERE id=1').get()) this.save(initialState(c, mode), []);
    const s = this.read();
    if (s.configHash !== configHash(c) || s.mode !== mode) {
      this.close(); throw new Error('Runtime configuration/mode mismatch: use a new runtime directory for a new experiment');
    }
  }
  read() { return JSON.parse(this.db.prepare('SELECT json FROM state WHERE id=1').get().json); }
  save(state, events = []) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO state(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(state));
      const put = this.db.prepare('INSERT INTO events(at,type,json) VALUES(?,?,?)');
      for (const event of events) put.run(event.at ?? Date.now(), event.type, JSON.stringify(event));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  events(n = 30) { return this.db.prepare('SELECT json FROM events ORDER BY id DESC LIMIT ?').all(n).map(x => JSON.parse(x.json)); }
  command(value) { this.db.prepare('INSERT INTO control(id,command) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET command=excluded.command').run(value); }
  getCommand() { return this.db.prepare('SELECT command FROM control WHERE id=1').get()?.command ?? null; }
  close() { this.db.close(); }
}
