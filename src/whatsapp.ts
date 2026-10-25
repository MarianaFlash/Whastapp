import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  type Contact,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  type proto,
} from 'baileys';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Logger } from 'pino';
import type { MessageEvent } from './tracker.js';

export type WAStatus = 'starting' | 'qr' | 'connecting' | 'connected' | 'disconnected' | 'logged_out' | 'stopped';

export interface WAState {
  status: WAStatus;
  qr: string | null;
  me: { jid: string; lid: string | null; name: string | null } | null;
  lastError: string | null;
  connectedAt: number | null;
  /** Mensajes recibidos durante la sincronización inicial de historial. */
  historyMessages: number;
  historyDone: boolean;
}

export interface NameUpdate {
  jid: string;
  name: string;
  /** true si es el nombre guardado en tu agenda; false si es el nombre que la persona se puso. */
  saved: boolean;
}

interface Options {
  authDir: string;
  logger: Logger;
  onMessage: (ev: MessageEvent) => void;
  onName: (update: NameUpdate) => void;
  /** Permite agrupar muchos mensajes de historial en una sola transacción. */
  batch?: (fn: () => void) => void;
}

type MessageValue = NonNullable<proto.IMessage[keyof proto.IMessage]>;

function toSeconds(ts: number | { toNumber(): number } | null | undefined): number {
  if (ts === null || ts === undefined) return Math.floor(Date.now() / 1000);
  if (typeof ts === 'number') return ts;
  if (typeof (ts as { toNumber?: () => number }).toNumber === 'function') {
    return (ts as { toNumber: () => number }).toNumber();
  }
  return Number(ts);
}

const IGNORED_TYPES = new Set<string>([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'pollUpdateMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'encReactionMessage',
  'encEventResponseMessage',
  'encCommentMessage',
  'placeholderMessage',
  'statusMentionMessage',
  'secretEncryptedMessage',
  'pollResultSnapshotMessage',
]);

function previewOf(content: proto.IMessage, type: keyof proto.IMessage): string {
  const value = content[type] as Record<string, unknown> | string | undefined;
  const caption = typeof value === 'object' && value ? (value.caption as string | undefined) : undefined;
  switch (type) {
    case 'conversation':
      return String(content.conversation ?? '');
    case 'extendedTextMessage':
      return content.extendedTextMessage?.text ?? '';
    case 'imageMessage':
      return caption ? `📷 ${caption}` : '📷 Foto';
    case 'videoMessage':
      return caption ? `🎥 ${caption}` : '🎥 Video';
    case 'ptvMessage':
      return '🎥 Video corto';
    case 'audioMessage':
      return content.audioMessage?.ptt ? '🎤 Nota de voz' : '🎵 Audio';
    case 'documentMessage':
      return `📄 ${content.documentMessage?.fileName ?? 'Documento'}`;
    case 'stickerMessage':
    case 'lottieStickerMessage':
      return '🧩 Sticker';
    case 'locationMessage':
    case 'liveLocationMessage':
      return '📍 Ubicación';
    case 'contactMessage':
    case 'contactsArrayMessage':
      return '👤 Contacto';
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
    case 'pollCreationMessageV4':
    case 'pollCreationMessageV5':
      return `📊 Encuesta`;
    case 'eventMessage':
      return `📅 Evento`;
    case 'orderMessage':
    case 'productMessage':
      return '🛍️ Producto';
    case 'buttonsMessage':
    case 'templateMessage':
    case 'listMessage':
    case 'interactiveMessage':
      return '💬 Mensaje';
    default:
      return '💬 Mensaje';
  }
}

export class WhatsAppClient extends EventEmitter {
  readonly state: WAState = {
    status: 'starting',
    qr: null,
    me: null,
    lastError: null,
    connectedAt: null,
    historyMessages: 0,
    historyDone: false,
  };

  private sock: WASocket | null = null;
  private stopped = false;
  private reconnectDelayMs = 2000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly names = new Map<string, { name: string; saved: boolean }>();
  private readonly groupLookups = new Set<string>();
  private myPn: string | null = null;
  private myLid: string | null = null;

  constructor(private readonly opts: Options) {
    super();
  }

  isConnected(): boolean {
    return this.state.status === 'connected' && this.sock !== null;
  }

  /** Jid de tu propio chat ("Tú"), al que se envían las notificaciones. */
  selfJid(): string | null {
    return this.myPn;
  }

  isMe(jid: string | null | undefined): boolean {
    if (!jid) return false;
    const normalized = jidNormalizedUser(jid);
    return normalized === this.myPn || normalized === this.myLid;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.state.status = 'stopped';
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
  }

  /** Cierra la sesión en WhatsApp (desvincula el dispositivo) y vuelve a pedir QR. */
  async logout(): Promise<void> {
    try {
      await this.sock?.logout('Desvinculado desde el dashboard');
    } catch (err) {
      this.opts.logger.warn({ err }, 'logout falló, limpiando credenciales igual');
    }
    this.clearAuth();
    this.state.status = 'logged_out';
    this.state.me = null;
    this.emit('state');
    this.scheduleReconnect(1000);
  }

  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock || !this.isConnected()) throw new Error('WhatsApp no está conectado');
    await this.sock.sendMessage(jid, { text });
  }

  async sendToSelf(text: string): Promise<void> {
    const jid = this.selfJid();
    if (!jid) throw new Error('Todavía no se conoce tu número');
    await this.sendText(jid, text);
  }

  private clearAuth(): void {
    fs.rmSync(this.opts.authDir, { recursive: true, force: true });
  }

  private setStatus(status: WAStatus): void {
    this.state.status = status;
    this.emit('state');
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.opts.logger.error({ err }, 'reconexión falló');
        this.scheduleReconnect(Math.min(this.reconnectDelayMs * 2, 60_000));
      });
    }, delayMs);
  }

  private async connect(): Promise<void> {
    const { logger } = this.opts;
    fs.mkdirSync(this.opts.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);

    let version: [number, number, number] | undefined;
    try {
      const latest = await fetchLatestBaileysVersion({ signal: AbortSignal.timeout(10_000) });
      version = latest.version;
    } catch (err) {
      logger.warn({ err }, 'no se pudo consultar la versión de WhatsApp Web, usando la incluida en Baileys');
    }

    const baileysLogger = logger.child({ module: 'baileys' }, { level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

    const sock = makeWASocket({
      version,
      logger: baileysLogger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });
    this.sock = sock;
    this.setStatus('connecting');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      if (update.qr) {
        this.state.qr = update.qr;
        this.setStatus('qr');
      }
      if (update.connection === 'connecting') this.setStatus('connecting');
      if (update.connection === 'open') {
        this.reconnectDelayMs = 2000;
        this.state.qr = null;
        this.state.lastError = null;
        this.state.connectedAt = Math.floor(Date.now() / 1000);
        this.captureMe(sock.user);
        this.setStatus('connected');
        logger.info({ me: this.state.me }, 'WhatsApp conectado');
      }
      if (update.connection === 'close') {
        const error = update.lastDisconnect?.error as { output?: { statusCode?: number }; message?: string } | undefined;
        const code = error?.output?.statusCode;
        this.state.lastError = error?.message ?? null;
        this.sock = null;
        if (this.stopped) return;

        if (code === DisconnectReason.loggedOut) {
          logger.warn('sesión cerrada desde el teléfono, se pedirá un nuevo QR');
          this.clearAuth();
          this.state.me = null;
          this.setStatus('logged_out');
          this.scheduleReconnect(1500);
          return;
        }
        if (code === DisconnectReason.restartRequired) {
          this.setStatus('connecting');
          this.scheduleReconnect(500);
          return;
        }
        if (code === DisconnectReason.connectionReplaced) {
          logger.warn('otra instancia abrió la misma sesión; reintento en 30 s');
          this.setStatus('disconnected');
          this.scheduleReconnect(30_000);
          return;
        }
        this.setStatus('disconnected');
        logger.warn({ code, err: this.state.lastError }, 'conexión cerrada, reintentando');
        this.scheduleReconnect(this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60_000);
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => this.rememberContacts(contacts));
    sock.ev.on('contacts.update', (contacts) => this.rememberContacts(contacts as Contact[]));
    sock.ev.on('chats.upsert', (chats) => {
      for (const chat of chats) if (chat.id && chat.name) this.rememberName(chat.id, chat.name, true);
    });
    sock.ev.on('chats.update', (chats) => {
      for (const chat of chats) if (chat.id && chat.name) this.rememberName(chat.id, chat.name, true);
    });
    sock.ev.on('groups.update', (groups) => {
      for (const g of groups) if (g.id && g.subject) this.rememberName(g.id, g.subject, true);
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, progress }) => {
      this.rememberContacts(contacts);
      for (const chat of chats) if (chat.id && chat.name) this.rememberName(chat.id, chat.name, true);
      const sorted = [...messages].sort((a, b) => toSeconds(a.messageTimestamp) - toSeconds(b.messageTimestamp));
      this.state.historyMessages += sorted.length;
      const run = () => {
        for (const msg of sorted) this.processMessage(msg);
      };
      if (this.opts.batch) this.opts.batch(run);
      else run();
      if (isLatest) this.state.historyDone = true;
      logger.info({ chats: chats.length, messages: sorted.length, progress, isLatest }, 'historial sincronizado');
      this.emit('state');
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) this.processMessage(msg);
    });
  }

  private captureMe(user: Contact | undefined): void {
    if (!user) return;
    this.myPn = user.phoneNumber ? jidNormalizedUser(user.phoneNumber) : isPnUser(user.id) ? jidNormalizedUser(user.id) : this.myPn;
    this.myLid = user.lid ? jidNormalizedUser(user.lid) : isLidUser(user.id) ? jidNormalizedUser(user.id) : this.myLid;
    this.state.me = { jid: this.myPn ?? jidNormalizedUser(user.id), lid: this.myLid, name: user.name ?? user.notify ?? null };
  }

  private rememberContacts(contacts: Partial<Contact>[]): void {
    for (const c of contacts) {
      const ids = [c.id, c.phoneNumber, c.lid].filter((x): x is string => Boolean(x));
      const saved = c.name?.trim();
      const pushed = (c.verifiedName ?? c.notify)?.trim();
      for (const id of ids) {
        if (saved) this.rememberName(id, saved, true);
        else if (pushed) this.rememberName(id, pushed, false);
      }
    }
  }

  private rememberName(rawJid: string, name: string, saved: boolean): void {
    const jid = jidNormalizedUser(rawJid);
    const current = this.names.get(jid);
    if (current && current.saved && !saved) return;
    if (current && current.name === name && current.saved === saved) return;
    this.names.set(jid, { name, saved });
    this.opts.onName({ jid, name, saved });
  }

  private nameFor(jid: string, altJid: string | null): { name: string; saved: boolean } | undefined {
    return this.names.get(jid) ?? (altJid ? this.names.get(altJid) : undefined);
  }

  private canonicalJids(key: WAMessageKey): { jid: string; altJid: string | null } {
    const remote = key.remoteJid!;
    const alt = key.remoteJidAlt ?? null;
    if (isJidGroup(remote)) return { jid: remote, altJid: null };
    if (isPnUser(remote)) {
      return { jid: jidNormalizedUser(remote), altJid: alt && isLidUser(alt) ? jidNormalizedUser(alt) : null };
    }
    if (isLidUser(remote)) {
      if (alt && isPnUser(alt)) return { jid: jidNormalizedUser(alt), altJid: jidNormalizedUser(remote) };
      return { jid: jidNormalizedUser(remote), altJid: null };
    }
    return { jid: remote, altJid: null };
  }

  private processMessage(msg: WAMessage): void {
    try {
      const ev = this.toEvent(msg);
      if (ev) this.opts.onMessage(ev);
    } catch (err) {
      this.opts.logger.warn({ err, id: msg.key?.id }, 'no se pudo procesar un mensaje');
    }
  }

  private toEvent(msg: WAMessage): MessageEvent | null {
    const key = msg.key;
    if (!key?.remoteJid || !key.id) return null;
    const remote = key.remoteJid;
    if (isJidStatusBroadcast(remote) || isJidBroadcast(remote) || isJidNewsletter(remote)) return null;

    const { jid, altJid } = this.canonicalJids(key);
    if (this.isMe(jid) || (altJid && this.isMe(altJid))) return null;

    const content = normalizeMessageContent(msg.message);
    if (!content) return null;
    const type = getContentType(content);
    if (!type || IGNORED_TYPES.has(type)) return null;

    const isGroup = Boolean(isJidGroup(remote));
    const fromMe = Boolean(key.fromMe);
    const ts = toSeconds(msg.messageTimestamp);
    const id = `${jid}:${key.id}:${fromMe ? 1 : 0}`;

    const known = this.nameFor(jid, altJid);
    let name: string | null = known?.name ?? null;
    if (!name && !isGroup && !fromMe && msg.pushName) name = msg.pushName;
    if (!name && isGroup) this.lookupGroupName(jid);

    if (type === 'reactionMessage') {
      return { id, jid, altJid, isGroup, fromMe, ts, kind: 'reaction', name };
    }

    const value = content[type] as MessageValue | undefined;
    const contextInfo =
      value && typeof value === 'object' && 'contextInfo' in value
        ? ((value as { contextInfo?: proto.IContextInfo | null }).contextInfo ?? undefined)
        : undefined;
    const mentioned = contextInfo?.mentionedJid ?? [];
    const mentionsMe = mentioned.some((m) => this.isMe(m));
    const quotesMe = Boolean(contextInfo?.quotedMessage) && this.isMe(contextInfo?.participant ?? undefined);

    return {
      id,
      jid,
      altJid,
      isGroup,
      fromMe,
      ts,
      kind: 'message',
      preview: previewOf(content, type).trim() || null,
      name,
      mentionsMe,
      quotesMe,
    };
  }

  private lookupGroupName(jid: string): void {
    if (!this.sock || this.groupLookups.has(jid)) return;
    this.groupLookups.add(jid);
    this.sock
      .groupMetadata(jid)
      .then((meta) => {
        if (meta?.subject) this.rememberName(jid, meta.subject, true);
      })
      .catch((err) => this.opts.logger.debug({ err, jid }, 'no se pudo leer el nombre del grupo'));
  }
}
