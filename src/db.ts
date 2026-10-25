import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings, sanitizeSettings, type Settings } from './settings.js';

export interface ChatRow {
  jid: string;
  alt_jid: string | null;
  name: string | null;
  is_group: number;
  vip_group: string | null;
  ignored: number;
  last_incoming_at: number | null;
  last_outgoing_at: number | null;
  waiting_since: number | null;
  unanswered_count: number;
  preview: string | null;
  preview_at: number | null;
  snoozed_until: number | null;
  updated_at: number;
}

export interface ResponseRow {
  id: number;
  jid: string;
  waiting_since: number;
  answered_at: number;
  wait_seconds: number;
  resolved_by: 'reply' | 'manual';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  alt_jid TEXT,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  vip_group TEXT,
  ignored INTEGER NOT NULL DEFAULT 0,
  last_incoming_at INTEGER,
  last_outgoing_at INTEGER,
  waiting_since INTEGER,
  unanswered_count INTEGER NOT NULL DEFAULT 0,
  preview TEXT,
  preview_at INTEGER,
  snoozed_until INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_alt ON chats(alt_jid);
CREATE INDEX IF NOT EXISTS idx_chats_waiting ON chats(waiting_since);

CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  waiting_since INTEGER NOT NULL,
  answered_at INTEGER NOT NULL,
  wait_seconds INTEGER NOT NULL,
  resolved_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_answered ON responses(answered_at);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  waiting_since INTEGER NOT NULL,
  level TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  UNIQUE(jid, waiting_since, level)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
`;

export class Repo {
  readonly db: DatabaseSync;
  private settingsCache: Settings | null = null;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Ejecuta varias escrituras en una sola transacción (mucho más rápido para el historial). */
  transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- chats ----------

  getChat(jid: string): ChatRow | undefined {
    return this.db.prepare('SELECT * FROM chats WHERE jid = ?').get(jid) as ChatRow | undefined;
  }

  /** Busca por jid principal o alternativo (teléfono vs. LID). */
  findChatByAnyJid(jid: string): ChatRow | undefined {
    return this.db
      .prepare('SELECT * FROM chats WHERE jid = ? OR alt_jid = ? LIMIT 1')
      .get(jid, jid) as ChatRow | undefined;
  }

  listChats(): ChatRow[] {
    return this.db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all() as unknown as ChatRow[];
  }

  listPending(): ChatRow[] {
    return this.db
      .prepare('SELECT * FROM chats WHERE waiting_since IS NOT NULL AND ignored = 0')
      .all() as unknown as ChatRow[];
  }

  createChat(jid: string, isGroup: boolean, now: number, name?: string | null, altJid?: string | null): ChatRow {
    this.db
      .prepare(
        `INSERT INTO chats (jid, alt_jid, name, is_group, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(jid) DO NOTHING`,
      )
      .run(jid, altJid ?? null, name ?? null, isGroup ? 1 : 0, now);
    return this.getChat(jid)!;
  }

  saveChat(chat: ChatRow): void {
    this.db
      .prepare(
        `UPDATE chats SET alt_jid = @alt_jid, name = @name, is_group = @is_group, vip_group = @vip_group,
          ignored = @ignored, last_incoming_at = @last_incoming_at, last_outgoing_at = @last_outgoing_at,
          waiting_since = @waiting_since, unanswered_count = @unanswered_count, preview = @preview,
          preview_at = @preview_at, snoozed_until = @snoozed_until, updated_at = @updated_at
         WHERE jid = @jid`,
      )
      .run({ ...chat } as Record<string, string | number | null>);
  }

  setName(jid: string, name: string, now: number): void {
    this.db
      .prepare('UPDATE chats SET name = ?, updated_at = ? WHERE (jid = ? OR alt_jid = ?)')
      .run(name, now, jid, jid);
  }

  setVip(jid: string, group: string | null, now: number): boolean {
    const result = this.db
      .prepare('UPDATE chats SET vip_group = ?, updated_at = ? WHERE jid = ?')
      .run(group, now, jid);
    return result.changes > 0;
  }

  setIgnored(jid: string, ignored: boolean, now: number): boolean {
    const result = this.db
      .prepare('UPDATE chats SET ignored = ?, updated_at = ? WHERE jid = ?')
      .run(ignored ? 1 : 0, now, jid);
    return result.changes > 0;
  }

  setSnooze(jid: string, until: number | null, now: number): boolean {
    const result = this.db
      .prepare('UPDATE chats SET snoozed_until = ?, updated_at = ? WHERE jid = ?')
      .run(until, now, jid);
    return result.changes > 0;
  }

  // ---------- respuestas ----------

  recordResponse(jid: string, waitingSince: number, answeredAt: number, resolvedBy: 'reply' | 'manual'): void {
    this.db
      .prepare(
        'INSERT INTO responses (jid, waiting_since, answered_at, wait_seconds, resolved_by) VALUES (?, ?, ?, ?, ?)',
      )
      .run(jid, waitingSince, answeredAt, Math.max(0, answeredAt - waitingSince), resolvedBy);
  }

  responsesSince(fromSeconds: number): ResponseRow[] {
    return this.db
      .prepare('SELECT * FROM responses WHERE answered_at >= ? ORDER BY answered_at DESC')
      .all(fromSeconds) as unknown as ResponseRow[];
  }

  // ---------- alertas ----------

  alertAlreadySent(jid: string, waitingSince: number, level: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM alerts WHERE jid = ? AND waiting_since = ? AND level = ?')
      .get(jid, waitingSince, level);
    return row !== undefined;
  }

  markAlertSent(jid: string, waitingSince: number, level: string, now: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO alerts (jid, waiting_since, level, sent_at) VALUES (?, ?, ?, ?)')
      .run(jid, waitingSince, level, now);
  }

  // ---------- mensajes ya procesados ----------

  /** Devuelve true si es la primera vez que vemos este id; false si ya se procesó. */
  markProcessed(id: string, ts: number): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO processed (id, ts) VALUES (?, ?)').run(id, ts);
    return result.changes > 0;
  }

  pruneProcessed(olderThanSeconds: number): void {
    this.db.prepare('DELETE FROM processed WHERE ts < ?').run(olderThanSeconds);
  }

  // ---------- settings ----------

  getSettings(): Settings {
    if (this.settingsCache) return this.settingsCache;
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as
      | { value: string }
      | undefined;
    let settings: Settings = sanitizeSettings(defaultSettings);
    if (row) {
      try {
        settings = sanitizeSettings(JSON.parse(row.value));
      } catch {
        /* valor corrupto: se usan los defaults */
      }
    }
    this.settingsCache = settings;
    return settings;
  }

  saveSettings(settings: Settings): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('settings', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(settings));
    this.settingsCache = settings;
  }

  getValue(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setValue(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
