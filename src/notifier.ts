import type { Logger } from 'pino';
import type { Repo } from './db.js';
import type { Level, Settings } from './settings.js';
import { compareUrgency, formatDuration, isQuietHours, localDateKey, localHHMM, toChatView, type ChatView } from './status.js';
import type { WhatsAppClient } from './whatsapp.js';

const LEVEL_EMOJI: Record<Level, string> = { ok: '⚪', yellow: '🟡', red: '🔴', critical: '🚨' };

interface Deps {
  repo: Repo;
  wa: WhatsAppClient;
  logger: Logger;
  publicUrl: string;
  timezone: string;
}

/**
 * Envía avisos a tu propio chat de WhatsApp ("Tú"):
 *  - inmediato cuando un chat pasa a crítico (una sola vez por espera)
 *  - resúmenes a las horas configuradas
 */
export class Notifier {
  constructor(private readonly deps: Deps) {}

  private settings(): Settings {
    return this.deps.repo.getSettings();
  }

  pendingViews(nowSeconds: number, settings = this.settings()): ChatView[] {
    return this.deps.repo
      .listPending()
      .map((row) => toChatView(row, settings, nowSeconds))
      .filter((view) => view.pending)
      .sort(compareUrgency);
  }

  async tick(now = new Date()): Promise<void> {
    await this.checkCritical(now);
    await this.maybeDigest(now);
  }

  async checkCritical(now: Date): Promise<void> {
    const settings = this.settings();
    if (!settings.notifyViaWhatsApp || !settings.notifyCriticalImmediately) return;
    if (isQuietHours(now, settings.quietHours, this.deps.timezone)) return;
    if (!this.deps.wa.isConnected()) return;

    const nowSeconds = Math.floor(now.getTime() / 1000);
    for (const view of this.pendingViews(nowSeconds, settings)) {
      if (view.level !== 'critical' || view.snoozed || view.waitingSince === null) continue;
      if (this.deps.repo.alertAlreadySent(view.jid, view.waitingSince, 'critical')) continue;
      try {
        await this.deps.wa.sendToSelf(this.criticalText(view, settings));
        this.deps.repo.markAlertSent(view.jid, view.waitingSince, 'critical', nowSeconds);
        this.deps.logger.info({ jid: view.jid, wait: view.waitSeconds }, 'alerta crítica enviada');
      } catch (err) {
        this.deps.logger.warn({ err, jid: view.jid }, 'no se pudo enviar la alerta crítica');
        return;
      }
    }
  }

  async maybeDigest(now: Date): Promise<void> {
    const settings = this.settings();
    if (!settings.notifyViaWhatsApp) return;
    const hhmm = localHHMM(now, this.deps.timezone);
    if (!settings.digestTimes.includes(hhmm)) return;
    const key = `${localDateKey(now, this.deps.timezone)} ${hhmm}`;
    if (this.deps.repo.getValue('lastDigestKey') === key) return;
    if (!this.deps.wa.isConnected()) return;
    this.deps.repo.setValue('lastDigestKey', key);
    const text = this.digestText(now, settings);
    if (!text) return;
    try {
      await this.deps.wa.sendToSelf(text);
      this.deps.logger.info({ at: hhmm }, 'resumen enviado');
    } catch (err) {
      this.deps.logger.warn({ err }, 'no se pudo enviar el resumen');
    }
  }

  /** Envía el resumen ahora mismo, sin importar la hora. Devuelve el texto enviado. */
  async sendDigestNow(now = new Date()): Promise<string> {
    const settings = this.settings();
    const text = this.digestText(now, settings) ?? `✅ *${settings.assistantName}*\nNo tienes chats esperando respuesta. ¡Todo al día!`;
    await this.deps.wa.sendToSelf(text);
    return text;
  }

  async sendTest(): Promise<string> {
    const settings = this.settings();
    const text = `👋 *${settings.assistantName}* ya está conectado.\nPor aquí te avisaré cuando alguien lleve mucho tiempo esperando tu respuesta.`;
    await this.deps.wa.sendToSelf(text);
    return text;
  }

  criticalText(view: ChatView, settings: Settings): string {
    const star = view.vipGroup ? ` ⭐ (${view.vipGroup})` : '';
    const count = view.unansweredCount > 1 ? `\n${view.unansweredCount} mensajes sin responder.` : '';
    const preview = view.preview ? `\n«${view.preview}»` : '';
    const link = view.waLink ? `\nAbrir chat: ${view.waLink}` : '';
    return (
      `🚨 *${settings.assistantName}* · Crítico\n` +
      `*${view.name}*${star} lleva *${formatDuration(view.waitSeconds)}* esperando tu respuesta.` +
      `${count}${preview}${link}`
    );
  }

  digestText(now: Date, settings: Settings): string | null {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const views = this.pendingViews(nowSeconds, settings).filter((v) => !v.snoozed);
    if (views.length === 0) return null;

    const critical = views.filter((v) => v.level === 'critical').length;
    const vip = views.filter((v) => v.tier === 'vip').length;
    const header = `📋 *${settings.assistantName}* · ${localHHMM(now, this.deps.timezone)}`;
    const summary =
      `${views.length} ${views.length === 1 ? 'chat espera' : 'chats esperan'} tu respuesta` +
      (critical ? ` · ${critical} ${critical === 1 ? 'crítico' : 'críticos'}` : '') +
      (vip ? ` · ${vip} VIP` : '');

    const max = 12;
    const lines = views.slice(0, max).map((v) => {
      const star = v.tier === 'vip' ? '⭐ ' : '';
      return `${LEVEL_EMOJI[v.level]} ${star}${v.name} · ${formatDuration(v.waitSeconds)}`;
    });
    if (views.length > max) lines.push(`…y ${views.length - max} más`);

    const footer = this.deps.publicUrl ? `\n\nDashboard: ${this.deps.publicUrl}` : '';
    return `${header}\n${summary}\n\n${lines.join('\n')}${footer}`;
  }
}
