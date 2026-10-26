/**
 * Configuración editable desde el dashboard. Se guarda como JSON en SQLite.
 * Los umbrales están en minutos de espera.
 */
export type Tier = 'vip' | 'normal';
export type Level = 'ok' | 'yellow' | 'red' | 'critical';
export type GroupsMode = 'ignore' | 'mentions' | 'all';

export interface Thresholds {
  yellow: number;
  red: number;
  critical: number;
}

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" en la zona horaria configurada */
  start: string;
  end: string;
}

export interface Settings {
  thresholds: Record<Tier, Thresholds>;
  quietHours: QuietHours;
  /** Horas "HH:MM" a las que se envía el resumen por WhatsApp */
  digestTimes: string[];
  notifyViaWhatsApp: boolean;
  notifyCriticalImmediately: boolean;
  groupsMode: GroupsMode;
  storePreview: boolean;
  vipGroups: string[];
  assistantName: string;
  reactionCountsAsReply: boolean;
  /**
   * Fecha "YYYY-MM-DD" desde la que se cuentan mensajes. Se fija una sola vez al instalar
   * (hoy menos INITIAL_HISTORY_DAYS) para no arrastrar pendientes viejos del historial.
   * Desde esa fecha en adelante todo cuenta, sin límite.
   */
  trackingSinceDate: string | null;
}

export const INITIAL_HISTORY_DAYS = 30;

export const defaultSettings: Settings = {
  thresholds: {
    vip: { yellow: 30, red: 120, critical: 360 },
    normal: { yellow: 180, red: 720, critical: 2880 },
  },
  quietHours: { enabled: true, start: '22:00', end: '07:00' },
  digestTimes: ['09:00', '13:00', '18:00'],
  notifyViaWhatsApp: true,
  notifyCriticalImmediately: true,
  groupsMode: 'mentions',
  storePreview: true,
  vipGroups: ['Clientes', 'Familia', 'Mejores amigos'],
  assistantName: 'Pendientes',
  reactionCountsAsReply: true,
  trackingSinceDate: null,
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clampMinutes(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.round(n);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeDate(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!ISO_DATE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) return null;
  return text;
}

/** Unix seconds (medianoche UTC) de la fecha de inicio, o 0 si no hay. */
export function trackingSinceSeconds(settings: Settings): number {
  if (!settings.trackingSinceDate) return 0;
  return Math.floor(Date.parse(`${settings.trackingSinceDate}T00:00:00Z`) / 1000);
}

function sanitizeThresholds(input: unknown, fallback: Thresholds): Thresholds {
  const raw = (input ?? {}) as Partial<Record<keyof Thresholds, unknown>>;
  const yellow = clampMinutes(raw.yellow, fallback.yellow);
  const red = Math.max(clampMinutes(raw.red, fallback.red), yellow);
  const critical = Math.max(clampMinutes(raw.critical, fallback.critical), red);
  return { yellow, red, critical };
}

function sanitizeTimes(input: unknown, fallback: string[]): string[] {
  if (!Array.isArray(input)) return fallback;
  const times = input
    .map((t) => String(t).trim())
    .filter((t) => HHMM.test(t));
  return Array.from(new Set(times)).sort();
}

function sanitizeStrings(input: unknown, fallback: string[]): string[] {
  if (!Array.isArray(input)) return fallback;
  const list = input
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0 && s.length <= 40);
  return Array.from(new Set(list)).slice(0, 12);
}

/** Mezcla lo que llega del dashboard con los valores por defecto y descarta basura. */
export function sanitizeSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const thresholds = (raw.thresholds ?? {}) as Record<string, unknown>;
  const quiet = (raw.quietHours ?? {}) as Record<string, unknown>;
  const groupsMode = raw.groupsMode;
  return {
    thresholds: {
      vip: sanitizeThresholds(thresholds.vip, defaultSettings.thresholds.vip),
      normal: sanitizeThresholds(thresholds.normal, defaultSettings.thresholds.normal),
    },
    quietHours: {
      enabled: quiet.enabled === undefined ? defaultSettings.quietHours.enabled : Boolean(quiet.enabled),
      start: HHMM.test(String(quiet.start)) ? String(quiet.start) : defaultSettings.quietHours.start,
      end: HHMM.test(String(quiet.end)) ? String(quiet.end) : defaultSettings.quietHours.end,
    },
    digestTimes: sanitizeTimes(raw.digestTimes, defaultSettings.digestTimes),
    notifyViaWhatsApp:
      raw.notifyViaWhatsApp === undefined ? defaultSettings.notifyViaWhatsApp : Boolean(raw.notifyViaWhatsApp),
    notifyCriticalImmediately:
      raw.notifyCriticalImmediately === undefined
        ? defaultSettings.notifyCriticalImmediately
        : Boolean(raw.notifyCriticalImmediately),
    groupsMode:
      groupsMode === 'ignore' || groupsMode === 'mentions' || groupsMode === 'all'
        ? groupsMode
        : defaultSettings.groupsMode,
    storePreview: raw.storePreview === undefined ? defaultSettings.storePreview : Boolean(raw.storePreview),
    vipGroups: sanitizeStrings(raw.vipGroups, defaultSettings.vipGroups),
    assistantName: String(raw.assistantName ?? defaultSettings.assistantName).trim().slice(0, 40) || defaultSettings.assistantName,
    reactionCountsAsReply:
      raw.reactionCountsAsReply === undefined
        ? defaultSettings.reactionCountsAsReply
        : Boolean(raw.reactionCountsAsReply),
    trackingSinceDate: sanitizeDate(raw.trackingSinceDate),
  };
}
