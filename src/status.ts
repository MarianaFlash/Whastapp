import type { Level, QuietHours, Settings, Thresholds, Tier } from './settings.js';
import type { ChatRow } from './db.js';

/** Nivel de alerta según los minutos que lleva esperando. */
export function levelFor(waitSeconds: number, thresholds: Thresholds): Level {
  const minutes = waitSeconds / 60;
  if (minutes >= thresholds.critical) return 'critical';
  if (minutes >= thresholds.red) return 'red';
  if (minutes >= thresholds.yellow) return 'yellow';
  return 'ok';
}

export const levelOrder: Record<Level, number> = { critical: 3, red: 2, yellow: 1, ok: 0 };

/** "3 h 20 min", "45 min", "2 d 4 h", "menos de 1 min" */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return 'menos de 1 min';
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  if (hours < 24) return restMin ? `${hours} h ${restMin} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} d ${restHours} h` : `${days} d`;
}

/** "HH:MM" local en la zona horaria dada. */
export function localHHMM(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour === '24' ? '00' : hour}:${minute}`;
}

/** "YYYY-MM-DD" local en la zona horaria dada. */
export function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** true si la hora local cae dentro del horario silencioso (soporta rangos que cruzan medianoche). */
export function isQuietHours(date: Date, quiet: QuietHours, timezone: string): boolean {
  if (!quiet.enabled) return false;
  const now = toMinutes(localHHMM(date, timezone));
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

export interface ChatView {
  jid: string;
  name: string;
  isGroup: boolean;
  vipGroup: string | null;
  tier: Tier;
  ignored: boolean;
  pending: boolean;
  /** La espera empezó hace más días que el límite configurado; no cuenta ni avisa. */
  stale: boolean;
  snoozed: boolean;
  snoozedUntil: number | null;
  waitingSince: number | null;
  waitSeconds: number;
  level: Level;
  unansweredCount: number;
  preview: string | null;
  lastIncomingAt: number | null;
  lastOutgoingAt: number | null;
  waLink: string | null;
}

export function displayName(chat: ChatRow): string {
  if (chat.name && chat.name.trim()) return chat.name.trim();
  const phone = phoneFromJid(chat.jid) ?? phoneFromJid(chat.alt_jid);
  if (phone) return `+${phone}`;
  if (chat.is_group) return 'Grupo';
  return 'Contacto sin nombre';
}

export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const match = /^(\d{6,20})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  return match ? match[1] : null;
}

export function waLinkFor(chat: ChatRow): string | null {
  const phone = phoneFromJid(chat.jid) ?? phoneFromJid(chat.alt_jid);
  return phone ? `https://wa.me/${phone}` : null;
}

/** Calcula el estado que ve el dashboard para un chat, a partir de la fila guardada. */
export function toChatView(chat: ChatRow, settings: Settings, nowSeconds: number): ChatView {
  const tier: Tier = chat.vip_group ? 'vip' : 'normal';
  const snoozed = chat.snoozed_until !== null && chat.snoozed_until > nowSeconds;
  const maxAge = settings.maxPendingAgeDays;
  const stale = chat.waiting_since !== null && maxAge > 0 && chat.waiting_since < nowSeconds - maxAge * 86400;
  const pending = chat.waiting_since !== null && !chat.ignored && !stale;
  const waitSeconds = chat.waiting_since !== null ? Math.max(0, nowSeconds - chat.waiting_since) : 0;
  const level: Level = pending && !snoozed ? levelFor(waitSeconds, settings.thresholds[tier]) : 'ok';
  return {
    jid: chat.jid,
    name: displayName(chat),
    isGroup: chat.is_group === 1,
    vipGroup: chat.vip_group,
    tier,
    ignored: chat.ignored === 1,
    pending,
    stale,
    snoozed,
    snoozedUntil: chat.snoozed_until,
    waitingSince: chat.waiting_since,
    waitSeconds,
    level,
    unansweredCount: chat.unanswered_count,
    preview: chat.preview,
    lastIncomingAt: chat.last_incoming_at,
    lastOutgoingAt: chat.last_outgoing_at,
    waLink: waLinkFor(chat),
  };
}

/** Orden de urgencia: críticos primero, luego VIP, luego quien lleva más tiempo esperando. */
export function compareUrgency(a: ChatView, b: ChatView): number {
  if (a.snoozed !== b.snoozed) return a.snoozed ? 1 : -1;
  const levelDiff = levelOrder[b.level] - levelOrder[a.level];
  if (levelDiff !== 0) return levelDiff;
  if (a.tier !== b.tier) return a.tier === 'vip' ? -1 : 1;
  return b.waitSeconds - a.waitSeconds;
}
