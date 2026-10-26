import type { ChatRow, Repo } from './db.js';
import { trackingSinceSeconds, type Settings } from './settings.js';

/** Evento normalizado que sale del cliente de WhatsApp y entra al rastreador. */
export interface MessageEvent {
  /** Identificador único del mensaje, para no procesarlo dos veces. */
  id: string;
  /** Jid canónico del chat (teléfono si se conoce, si no el LID). */
  jid: string;
  /** Jid alterno del mismo chat (LID cuando el principal es teléfono, o viceversa). */
  altJid?: string | null;
  isGroup: boolean;
  fromMe: boolean;
  /** Unix seconds */
  ts: number;
  kind: 'message' | 'reaction';
  preview?: string | null;
  /** Nombre que WhatsApp reporta para el remitente (pushName o agenda). */
  name?: string | null;
  mentionsMe?: boolean;
  quotesMe?: boolean;
}

export interface TrackResult {
  chat: ChatRow;
  /** Se cerró una espera porque respondiste. */
  resolved: boolean;
  /** Empezó una nueva espera. */
  started: boolean;
  skipped: boolean;
}

/**
 * Mantiene por chat: cuándo fue el último mensaje tuyo, cuándo fue el último de la otra
 * persona, y desde cuándo hay un mensaje de ella sin respuesta tuya (waiting_since).
 */
export class Tracker {
  constructor(
    private readonly repo: Repo,
    private readonly getSettings: () => Settings,
  ) {}

  private resolveChat(ev: MessageEvent): ChatRow {
    const existing = this.repo.findChatByAnyJid(ev.jid) ?? (ev.altJid ? this.repo.findChatByAnyJid(ev.altJid) : undefined);
    if (existing) {
      if (!existing.alt_jid && ev.altJid && ev.altJid !== existing.jid) {
        existing.alt_jid = ev.altJid;
      }
      return existing;
    }
    return this.repo.createChat(ev.jid, ev.isGroup, ev.ts, ev.name ?? null, ev.altJid ?? null);
  }

  handle(ev: MessageEvent): TrackResult {
    const settings = this.getSettings();

    // Mensajes anteriores a la fecha de inicio (fijada al instalar) se ignoran por completo.
    if (ev.ts < trackingSinceSeconds(settings)) {
      const existing = this.repo.findChatByAnyJid(ev.jid);
      return { chat: existing ?? this.resolveChat(ev), resolved: false, started: false, skipped: true };
    }

    const chat = this.resolveChat(ev);
    const result: TrackResult = { chat, resolved: false, started: false, skipped: false };

    if (!this.repo.markProcessed(ev.id, ev.ts)) {
      result.skipped = true;
      return result;
    }

    if (ev.name && !ev.fromMe && !ev.isGroup && !chat.name) chat.name = ev.name;
    chat.updated_at = Math.max(chat.updated_at, ev.ts);

    if (ev.kind === 'reaction') {
      if (ev.fromMe && settings.reactionCountsAsReply) this.applyOutgoing(chat, ev.ts, result);
      this.repo.saveChat(chat);
      return result;
    }

    if (ev.fromMe) {
      this.applyOutgoing(chat, ev.ts, result);
      this.repo.saveChat(chat);
      return result;
    }

    // Mensaje de otra persona.
    chat.last_incoming_at = Math.max(chat.last_incoming_at ?? 0, ev.ts);

    const countsAsPending = !ev.isGroup || this.groupMessageCounts(ev, settings);
    const arrivedBeforeMyLastReply = chat.last_outgoing_at !== null && ev.ts <= chat.last_outgoing_at;

    if (countsAsPending && !arrivedBeforeMyLastReply) {
      if (chat.waiting_since === null) {
        chat.waiting_since = ev.ts;
        chat.unanswered_count = 1;
        chat.snoozed_until = null;
        result.started = true;
      } else {
        chat.unanswered_count += 1;
      }
      if (settings.storePreview && ev.preview && (chat.preview_at === null || ev.ts >= chat.preview_at)) {
        chat.preview = ev.preview.slice(0, 160);
        chat.preview_at = ev.ts;
      }
    } else if (settings.storePreview && ev.preview && !ev.isGroup && (chat.preview_at === null || ev.ts >= chat.preview_at)) {
      chat.preview = ev.preview.slice(0, 160);
      chat.preview_at = ev.ts;
    }

    this.repo.saveChat(chat);
    return result;
  }

  private groupMessageCounts(ev: MessageEvent, settings: Settings): boolean {
    switch (settings.groupsMode) {
      case 'all':
        return true;
      case 'mentions':
        return Boolean(ev.mentionsMe || ev.quotesMe);
      case 'ignore':
      default:
        return false;
    }
  }

  private applyOutgoing(chat: ChatRow, ts: number, result: TrackResult): void {
    chat.last_outgoing_at = Math.max(chat.last_outgoing_at ?? 0, ts);
    if (chat.waiting_since !== null && ts >= chat.waiting_since) {
      this.repo.recordResponse(chat.jid, chat.waiting_since, ts, 'reply');
      chat.waiting_since = null;
      chat.unanswered_count = 0;
      chat.snoozed_until = null;
      chat.preview = null;
      chat.preview_at = null;
      result.resolved = true;
    }
  }

  /**
   * Aplica la fecha de inicio a lo que ya está guardado (historial sincronizado con una versión
   * anterior, o fecha cambiada desde Ajustes). Las esperas que empezaron antes de la fecha se
   * cierran sin contar como respuesta. Si en un chat directo hubo mensajes después de la fecha,
   * la espera se reinicia desde el último de ellos. Devuelve cuántos chats se tocaron.
   */
  applyStartDate(now: number): number {
    const cutoff = trackingSinceSeconds(this.getSettings());
    if (cutoff <= 0) return 0;
    let touched = 0;
    this.repo.transaction(() => {
      for (const chat of this.repo.listWaiting()) {
        if (chat.waiting_since === null || chat.waiting_since >= cutoff) continue;
        const keep = chat.is_group === 0 && chat.last_incoming_at !== null && chat.last_incoming_at >= cutoff;
        if (keep) {
          chat.waiting_since = chat.last_incoming_at;
          chat.unanswered_count = 1;
        } else {
          chat.waiting_since = null;
          chat.unanswered_count = 0;
          chat.preview = null;
          chat.preview_at = null;
          chat.snoozed_until = null;
        }
        chat.updated_at = now;
        this.repo.saveChat(chat);
        touched += 1;
      }
    });
    return touched;
  }

  /** "Listo / no requiere respuesta": cierra la espera sin contarla como respuesta. */
  resolveManually(jid: string, now: number): ChatRow | undefined {
    const chat = this.repo.getChat(jid);
    if (!chat) return undefined;
    if (chat.waiting_since !== null) {
      this.repo.recordResponse(chat.jid, chat.waiting_since, now, 'manual');
      chat.waiting_since = null;
      chat.unanswered_count = 0;
      chat.snoozed_until = null;
      chat.preview = null;
      chat.preview_at = null;
      chat.updated_at = now;
      this.repo.saveChat(chat);
    }
    return chat;
  }
}
