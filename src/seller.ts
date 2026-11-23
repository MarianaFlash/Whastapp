import type { Logger } from 'pino';
import type { ConversationTurn, ReplyDecision, Responder } from './ai.js';
import { LONG_PAUSE_SECONDS, type PauseReason, type Repo, type SellerChatRow } from './db.js';
import type { SellerSettings } from './settings.js';
import type { MessageEvent } from './tracker.js';

/** Lo que el modo vendedor usa del cliente de WhatsApp. */
export interface SellerWhatsApp {
  isConnected(): boolean;
  selfJid(): string | null;
  isMe(jid: string | null | undefined): boolean;
  sendText(jid: string, text: string): Promise<string>;
  sendTyping(jid: string, state: 'composing' | 'paused'): Promise<void>;
}

interface Deps {
  repo: Repo;
  wa: SellerWhatsApp;
  logger: Logger;
  /** null si falta ANTHROPIC_API_KEY: el modo vendedor queda sin poder responder. */
  responder: Responder | null;
  timezone: string;
  publicUrl: string;
  /** Reloj y temporizadores inyectables para las pruebas. */
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SellerStatus {
  enabled: boolean;
  ready: boolean;
  hasApiKey: boolean;
  hasInstructions: boolean;
  model: string | null;
  /** Qué falta para que funcione, en palabras para quien usa el dashboard. */
  problem: string | null;
}

export interface SellerChatView {
  state: 'bot' | 'paused';
  reason: PauseReason | null;
  pausedUntil: number | null;
  summary: string | null;
  botReplies: number;
}

/** Mensajes del chat que se le pasan a la IA. */
const HISTORY_LIMIT = 40;
/** Tope de respuestas del asistente en un mismo chat por hora (protege de bucles entre bots). */
const PER_CHAT_MAX_PER_HOUR = 15;
/** Reintentos cuando WhatsApp está desconectado al momento de responder. */
const OFFLINE_RETRIES = 20;
const OFFLINE_RETRY_MS = 30_000;


/** Tiempo de "escribiendo…" según el largo del mensaje, entre 1,5 y 7 segundos. */
export function typingDelayMs(text: string): number {
  return Math.min(7000, Math.max(1500, 1500 + text.length * 35));
}

/** "+573001234567" para chats con número; null para chats que solo muestran un LID. */
export function phoneOf(jid: string): string | null {
  const [user, server] = jid.split('@');
  if (server !== 's.whatsapp.net' || !user || !/^\d+$/.test(user)) return null;
  return `+${user}`;
}

export function ownerJidOf(settings: SellerSettings): string | null {
  return settings.ownerNumber ? `${settings.ownerNumber}@s.whatsapp.net` : null;
}

export function sellerChatView(row: SellerChatRow | undefined, nowSeconds: number): SellerChatView {
  const paused = Boolean(row?.paused_until && row.paused_until > nowSeconds);
  return {
    state: paused ? 'paused' : 'bot',
    reason: paused ? (row!.pause_reason ?? null) : null,
    pausedUntil: paused ? row!.paused_until : null,
    summary: paused ? (row!.handoff_summary ?? null) : null,
    botReplies: row?.bot_replies ?? 0,
  };
}

export interface AlertInput {
  kind: 'handoff' | 'error' | 'limit';
  name: string | null;
  jid: string;
  reason: string;
  summary: string;
  lastBuyerText: string | null;
  pauseHours: number;
  publicUrl: string;
}

/** Texto del aviso que llega a tu WhatsApp personal. */
export function alertText(input: AlertInput): string {
  const phone = phoneOf(input.jid);
  const who = [input.name ? `*${input.name}*` : '*Comprador sin nombre*', phone].filter(Boolean).join(' · ');
  const title =
    input.kind === 'handoff'
      ? '🔔 *Te necesitan en un chat de ventas*'
      : input.kind === 'error'
        ? '⚠️ *El asistente no pudo responder un chat*'
        : '⏸️ *Pausé el asistente en un chat*';
  const lines = [title, who];
  if (input.reason) lines.push(`Motivo: ${input.reason}`);
  if (input.summary) lines.push(`Resumen: ${input.summary}`);
  if (input.lastBuyerText) lines.push(`Último mensaje: «${input.lastBuyerText.slice(0, 300)}»`);
  lines.push('');
  lines.push(
    input.kind === 'handoff'
      ? 'El asistente dejó de responder en ese chat. Contéstale tú desde el WhatsApp de ventas.'
      : `Contéstale tú desde el WhatsApp de ventas. El asistente queda en pausa en ese chat ${input.pauseHours} h.`,
  );
  if (input.publicUrl) lines.push(`Para volver a activarlo: ${input.publicUrl}`);
  return lines.join('\n');
}

/**
 * Modo vendedor: cuando un comprador escribe, espera unos segundos (por si manda varios
 * mensajes seguidos), le pide a la IA una respuesta con las instrucciones de quien vende
 * y la envía. Si tú respondes desde el teléfono, o la IA decide pasarte la conversación,
 * el asistente se calla en ese chat y te avisa.
 */
export class Seller {
  private readonly timers = new Map<string, unknown>();
  private readonly running = new Set<string>();
  private readonly offlineAttempts = new Map<string, number>();
  private lastLimitAlertAt = 0;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: Deps) {
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  private settings(): SellerSettings {
    return this.deps.repo.getSettings().seller;
  }

  private nowSeconds(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  status(): SellerStatus {
    const s = this.settings();
    const hasApiKey = this.deps.responder !== null;
    const hasInstructions = s.instructions.length > 0;
    let problem: string | null = null;
    if (!hasApiKey) problem = 'Falta la clave ANTHROPIC_API_KEY en las variables del servidor.';
    else if (!hasInstructions) problem = 'Faltan las instrucciones: escribe qué vendes y cómo debe responder.';
    return {
      enabled: s.enabled,
      ready: s.enabled && hasApiKey && hasInstructions,
      hasApiKey,
      hasInstructions,
      model: this.deps.responder?.model ?? null,
      problem,
    };
  }

  /** Chats que nunca se contestan: tu propio chat y tu número personal. */
  private isExcluded(jid: string, altJid: string | null | undefined, settings: SellerSettings): boolean {
    if (this.deps.wa.isMe(jid) || (altJid && this.deps.wa.isMe(altJid))) return true;
    const owner = ownerJidOf(settings);
    return owner !== null && (jid === owner || altJid === owner);
  }

  private isPaused(jid: string, nowSeconds: number): boolean {
    const chat = this.deps.repo.getSellerChat(jid);
    return Boolean(chat?.paused_until && chat.paused_until > nowSeconds);
  }

  /** Recibe cada mensaje después del rastreador. `skipped` = repetido o anterior a la fecha de inicio. */
  handle(ev: MessageEvent, skipped: boolean): void {
    const settings = this.settings();
    if (!settings.enabled) return;
    if (skipped || ev.isGroup || ev.kind !== 'message' || !ev.live) return;
    if (this.isExcluded(ev.jid, ev.altJid, settings)) return;
    const text = (ev.text ?? ev.preview ?? '').trim();
    if (!text) return;

    const { repo, logger } = this.deps;
    const jid = ev.jid;
    const now = this.nowSeconds();

    if (ev.fromMe) {
      // El eco de lo que mandó el asistente ya quedó guardado al enviarlo.
      if (ev.byApp) return;
      repo.touchSellerChat(jid, ev.remoteJid ?? null, ev.ts);
      repo.addSellerMessage(jid, 'owner', text, ev.ts, ev.id);
      this.cancel(jid);
      const until = now + settings.humanPauseHours * 3600;
      const chat = repo.getSellerChat(jid);
      if ((chat?.paused_until ?? 0) < until) {
        repo.setSellerPause(jid, until, 'owner', now);
        logger.info({ jid, hours: settings.humanPauseHours }, 'respondiste tú: el asistente se pausa en este chat');
      }
      return;
    }

    repo.touchSellerChat(jid, ev.remoteJid ?? jid, ev.ts);
    repo.addSellerMessage(jid, 'buyer', text, ev.ts, ev.id);
    if (now - ev.ts > settings.maxMessageAgeHours * 3600) return;
    if (this.isPaused(jid, now)) return;
    this.schedule(jid, settings.replyDelaySeconds * 1000);
  }

  /** Al reconectar: programa respuesta a los chats que quedaron con un mensaje sin contestar. */
  resumePending(): void {
    const settings = this.settings();
    if (!settings.enabled) return;
    const now = this.nowSeconds();
    let delay = 3000;
    for (const chat of this.deps.repo.listSellerChats()) {
      if (chat.paused_until && chat.paused_until > now) continue;
      const [last] = this.deps.repo.recentSellerMessages(chat.jid, 1);
      if (!last || last.role !== 'buyer' || now - last.ts > settings.maxMessageAgeHours * 3600) continue;
      if (this.timers.has(chat.jid)) continue;
      this.schedule(chat.jid, delay);
      delay += 4000;
    }
  }

  pause(jid: string): void {
    this.cancel(jid);
    this.deps.repo.setSellerPause(jid, this.nowSeconds() + LONG_PAUSE_SECONDS, 'manual', this.nowSeconds());
  }

  /** Reactiva el asistente. No responde hasta que el comprador vuelva a escribir. */
  resume(jid: string): void {
    this.deps.repo.setSellerPause(jid, null, null, this.nowSeconds());
  }

  /** Prueba desde el dashboard: qué respondería a un mensaje, sin enviar nada. */
  async preview(message: string, instructions?: string): Promise<ReplyDecision> {
    const responder = this.deps.responder;
    if (!responder) throw new Error('Falta la clave ANTHROPIC_API_KEY en las variables del servidor.');
    const text = instructions?.trim() || this.settings().instructions;
    if (!text) throw new Error('Escribe las instrucciones antes de probar.');
    return responder.decide({
      instructions: text,
      turns: [{ role: 'buyer', text: message }],
      now: new Date(this.nowMs()),
      timezone: this.deps.timezone,
      buyerName: null,
    });
  }

  /** Cancela todo lo programado (al apagar). */
  stop(): void {
    for (const jid of [...this.timers.keys()]) this.cancel(jid);
  }

  private cancel(jid: string): void {
    const handle = this.timers.get(jid);
    if (handle !== undefined) this.clearTimer(handle);
    this.timers.delete(jid);
  }

  private schedule(jid: string, ms: number): void {
    this.cancel(jid);
    const handle = this.setTimer(() => {
      this.timers.delete(jid);
      this.reply(jid).catch((err) => this.deps.logger.error({ err, jid }, 'modo vendedor: fallo inesperado'));
    }, ms);
    this.timers.set(jid, handle);
  }

  /** Genera y envía la respuesta del asistente para un chat. Exportado para las pruebas. */
  async reply(jid: string): Promise<void> {
    const { repo, wa, logger, responder } = this.deps;
    const settings = this.settings();
    if (!settings.enabled || !responder || !settings.instructions) return;

    // Si ya hay una respuesta en curso en este chat, se vuelve a mirar cuando termine.
    if (this.running.has(jid)) {
      this.schedule(jid, 5000);
      return;
    }
    if (!wa.isConnected()) {
      const attempts = (this.offlineAttempts.get(jid) ?? 0) + 1;
      this.offlineAttempts.set(jid, attempts);
      if (attempts <= OFFLINE_RETRIES) this.schedule(jid, OFFLINE_RETRY_MS);
      return;
    }
    this.offlineAttempts.delete(jid);

    const now = this.nowSeconds();
    if (this.isPaused(jid, now)) return;
    const turns = repo.recentSellerMessages(jid, HISTORY_LIMIT);
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'buyer') return;

    const name = repo.findChatByAnyJid(jid)?.name ?? null;
    const hourAgo = now - 3600;
    if (repo.countBotMessagesSince(hourAgo) >= settings.maxRepliesPerHour) {
      await this.escalate(jid, 'limit', `Se alcanzó el tope de ${settings.maxRepliesPerHour} respuestas por hora`, '', last.text, name);
      return;
    }
    if (repo.countBotMessagesSince(hourAgo, jid) >= PER_CHAT_MAX_PER_HOUR) {
      await this.escalate(jid, 'limit', `Este chat ya recibió ${PER_CHAT_MAX_PER_HOUR} respuestas en una hora`, '', last.text, name);
      return;
    }

    this.running.add(jid);
    try {
      let decision: ReplyDecision;
      try {
        decision = await responder.decide({
          instructions: settings.instructions,
          turns: turns.map((t): ConversationTurn => ({ role: t.role, text: t.text })),
          now: new Date(this.nowMs()),
          timezone: this.deps.timezone,
          buyerName: name,
        });
      } catch (err) {
        logger.error({ err, jid }, 'modo vendedor: la IA no respondió');
        await this.escalate(jid, 'error', (err as Error).message.slice(0, 160), '', last.text, name);
        return;
      }

      // Mientras la IA pensaba pudiste responder tú, o el comprador pudo escribir de nuevo.
      if (this.isPaused(jid, this.nowSeconds())) return;
      const [latest] = repo.recentSellerMessages(jid, 1);
      if (latest && latest.id !== last.id) return;

      const target = repo.getSellerChat(jid)?.reply_jid ?? jid;
      await wa.sendTyping(target, 'composing');
      await this.sleep(typingDelayMs(decision.reply));
      if (this.isPaused(jid, this.nowSeconds())) {
        await wa.sendTyping(target, 'paused');
        return;
      }
      const msgId = await wa.sendText(target, decision.reply);
      // Nunca antes del mensaje que responde, aunque el reloj del servidor vaya atrasado.
      const sentAt = Math.max(this.nowSeconds(), last.ts);
      repo.addSellerMessage(jid, 'bot', decision.reply, sentAt, msgId);
      repo.recordBotReply(jid, sentAt);
      logger.info({ jid, handoff: decision.handoff }, 'modo vendedor: respuesta enviada');

      if (decision.handoff) {
        await this.escalate(jid, 'handoff', decision.reason, decision.summary, last.text, name);
      }
    } finally {
      this.running.delete(jid);
    }
  }

  /** Pausa el asistente en el chat y te avisa a tu WhatsApp. */
  private async escalate(
    jid: string,
    kind: 'handoff' | 'error' | 'limit',
    reason: string,
    summary: string,
    lastBuyerText: string | null,
    name: string | null,
  ): Promise<void> {
    const { repo, wa, logger } = this.deps;
    const settings = this.settings();
    const now = this.nowSeconds();
    const until = kind === 'handoff' ? now + LONG_PAUSE_SECONDS : now + settings.humanPauseHours * 3600;
    repo.setSellerPause(jid, until, kind, now, kind === 'handoff' ? summary || reason : null);

    // Un solo aviso por hora para el tope global, para no llenarte el chat.
    if (kind === 'limit' && reason.startsWith('Se alcanzó') && this.nowMs() - this.lastLimitAlertAt < 3600_000) return;
    if (kind === 'limit') this.lastLimitAlertAt = this.nowMs();

    const target = ownerJidOf(settings) ?? wa.selfJid();
    if (!target) return;
    const text = alertText({
      kind,
      name,
      jid,
      reason,
      summary,
      lastBuyerText,
      pauseHours: settings.humanPauseHours,
      publicUrl: this.deps.publicUrl,
    });
    try {
      await wa.sendText(target, text);
    } catch (err) {
      logger.warn({ err, jid }, 'modo vendedor: no se pudo enviar el aviso');
    }
  }
}

