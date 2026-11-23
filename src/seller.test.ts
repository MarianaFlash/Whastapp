import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { buildMessages, type DecideInput, type ReplyDecision, type Responder } from './ai.js';
import { Repo } from './db.js';
import { alertText, phoneOf, Seller, typingDelayMs, type SellerWhatsApp } from './seller.js';
import { defaultSettings, defaultSellerSettings, type SellerSettings } from './settings.js';
import type { MessageEvent } from './tracker.js';

const ME = '573000000000@s.whatsapp.net';
const OWNER = '573009998877';
const OWNER_JID = `${OWNER}@s.whatsapp.net`;
const BUYER = '573101234567@s.whatsapp.net';
const BUYER_LID = '123456789012345@lid';
const GROUP = '120363000000000000@g.us';
const START_MS = 1_800_000_000_000;
const NOW = START_MS / 1000;

class FakeWa implements SellerWhatsApp {
  connected = true;
  sent: { jid: string; text: string; id: string }[] = [];
  typing: { jid: string; state: string }[] = [];
  private seq = 0;
  isConnected(): boolean {
    return this.connected;
  }
  selfJid(): string {
    return ME;
  }
  isMe(jid: string | null | undefined): boolean {
    return jid === ME;
  }
  async sendText(jid: string, text: string): Promise<string> {
    this.seq += 1;
    const id = `sent-${this.seq}`;
    this.sent.push({ jid, text, id });
    return id;
  }
  async sendTyping(jid: string, state: 'composing' | 'paused'): Promise<void> {
    this.typing.push({ jid, state });
  }
}

class FakeResponder implements Responder {
  readonly model = 'modelo-de-prueba';
  calls: DecideInput[] = [];
  next: ReplyDecision | Error = { reply: 'Hola, sí está disponible.', handoff: false, reason: '', summary: '' };
  during: (() => void) | null = null;
  async decide(input: DecideInput): Promise<ReplyDecision> {
    this.calls.push(input);
    this.during?.();
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

let repo: Repo;
let wa: FakeWa;
let responder: FakeResponder;
let seller: Seller;
let clockMs: number;
let timers: Map<number, () => void>;
let timerSeq: number;
let seq: number;

function setSeller(partial: Partial<SellerSettings>): void {
  repo.saveSettings({
    ...defaultSettings,
    seller: { ...defaultSellerSettings, enabled: true, instructions: 'Vendo un carro.', ownerNumber: OWNER, ...partial },
  });
}

function buyer(text: string, extra: Partial<MessageEvent> = {}): MessageEvent {
  seq += 1;
  return {
    id: `${BUYER}:m${seq}:0`,
    jid: BUYER,
    altJid: BUYER_LID,
    remoteJid: BUYER_LID,
    isGroup: false,
    fromMe: false,
    ts: Math.floor(clockMs / 1000),
    kind: 'message',
    text,
    preview: text,
    live: true,
    byApp: false,
    name: 'Carlos',
    ...extra,
  };
}

function mine(text: string, extra: Partial<MessageEvent> = {}): MessageEvent {
  return buyer(text, { fromMe: true, id: `${BUYER}:m${seq + 1}:1`, ...extra });
}

/** Corre los temporizadores pendientes y deja terminar las promesas. */
async function runTimers(): Promise<void> {
  const pending = [...timers.values()];
  timers.clear();
  for (const fn of pending) fn();
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  repo = new Repo(':memory:');
  wa = new FakeWa();
  responder = new FakeResponder();
  clockMs = START_MS;
  timers = new Map();
  timerSeq = 0;
  seq = 0;
  setSeller({});
  seller = new Seller({
    repo,
    wa,
    logger: pino({ level: 'silent' }),
    responder,
    timezone: 'America/Bogota',
    publicUrl: 'https://ventas.example.com',
    nowMs: () => clockMs,
    sleep: async () => {},
    setTimer: (fn) => {
      timerSeq += 1;
      timers.set(timerSeq, fn);
      return timerSeq;
    },
    clearTimer: (handle) => timers.delete(handle as number),
  });
  // El rastreador crea el chat con el nombre; aquí lo simulamos.
  repo.createChat(BUYER, false, NOW, 'Carlos', BUYER_LID);
});

describe('Modo vendedor', () => {
  it('responde al comprador después de la espera, en el mismo chat, y guarda la conversación', async () => {
    seller.handle(buyer('Hola, ¿está disponible?'), false);
    assert.equal(wa.sent.length, 0, 'no responde de inmediato');
    assert.equal(timers.size, 1);

    await runTimers();
    assert.equal(wa.sent.length, 1);
    assert.equal(wa.sent[0]!.jid, BUYER_LID, 'responde al jid por el que llegó el mensaje');
    assert.equal(wa.sent[0]!.text, 'Hola, sí está disponible.');
    assert.deepEqual(wa.typing.map((t) => t.state), ['composing']);
    assert.equal(responder.calls[0]!.buyerName, 'Carlos');
    assert.equal(responder.calls[0]!.instructions, 'Vendo un carro.');

    const roles = repo.recentSellerMessages(BUYER, 10).map((m) => m.role);
    assert.deepEqual(roles, ['buyer', 'bot']);
  });

  it('si el comprador manda varios mensajes seguidos, contesta una sola vez con todo', async () => {
    seller.handle(buyer('Hola'), false);
    seller.handle(buyer('¿Es negociable?'), false);
    assert.equal(timers.size, 1, 'el segundo mensaje reinicia la espera');
    await runTimers();
    assert.equal(wa.sent.length, 1);
    assert.deepEqual(
      responder.calls[0]!.turns.map((t) => t.text),
      ['Hola', '¿Es negociable?'],
    );
  });

  it('si respondes tú desde el teléfono, se calla en ese chat', async () => {
    seller.handle(buyer('Hola'), false);
    seller.handle(mine('Hola Carlos, soy yo'), false);
    assert.equal(timers.size, 0, 'cancela la respuesta programada');
    const chat = repo.getSellerChat(BUYER)!;
    assert.equal(chat.pause_reason, 'owner');
    assert.equal(chat.paused_until, NOW + 24 * 3600);

    seller.handle(buyer('¿Me lo muestras mañana?'), false);
    await runTimers();
    assert.equal(wa.sent.length, 0);
  });

  it('el eco de lo que envía el asistente no cuenta como respuesta tuya', async () => {
    seller.handle(buyer('Hola'), false);
    await runTimers();
    seller.handle(mine('Hola, sí está disponible.', { byApp: true }), false);
    assert.equal(repo.getSellerChat(BUYER)!.paused_until, null);
  });

  it('pasa la conversación: responde, se pausa y te avisa a tu número con el resumen', async () => {
    responder.next = {
      reply: 'Le paso tu oferta a la dueña, ella te responde muy pronto.',
      handoff: true,
      reason: 'Hizo una oferta',
      summary: 'Carlos ofrece 60 millones de contado.',
    };
    seller.handle(buyer('Te doy 60 millones de contado'), false);
    await runTimers();

    assert.equal(wa.sent.length, 2);
    assert.equal(wa.sent[0]!.jid, BUYER_LID);
    const alert = wa.sent[1]!;
    assert.equal(alert.jid, OWNER_JID);
    assert.match(alert.text, /Hizo una oferta/);
    assert.match(alert.text, /60 millones de contado/);
    assert.match(alert.text, /\+573101234567/);
    assert.match(alert.text, /https:\/\/ventas\.example\.com/);

    const chat = repo.getSellerChat(BUYER)!;
    assert.equal(chat.pause_reason, 'handoff');
    assert.equal(chat.handoff_summary, 'Carlos ofrece 60 millones de contado.');

    seller.handle(buyer('¿Hola?'), false);
    assert.equal(timers.size, 0, 'no vuelve a responder hasta que lo reactives');

    seller.resume(BUYER);
    assert.equal(repo.getSellerChat(BUYER)!.paused_until, null);
    assert.equal(repo.getSellerChat(BUYER)!.handoff_summary, null);
  });

  it('si la IA falla, no le escribe al comprador y te avisa', async () => {
    responder.next = new Error('sin conexión con la API');
    seller.handle(buyer('Hola'), false);
    await runTimers();
    assert.equal(wa.sent.length, 1);
    assert.equal(wa.sent[0]!.jid, OWNER_JID);
    assert.match(wa.sent[0]!.text, /no pudo responder/);
    assert.equal(repo.getSellerChat(BUYER)!.pause_reason, 'error');
  });

  it('sin número personal, los avisos llegan a tu chat "Tú"', async () => {
    setSeller({ ownerNumber: '' });
    responder.next = { reply: 'Ya te confirma.', handoff: true, reason: 'Pregunta sin respuesta', summary: '' };
    seller.handle(buyer('¿Tiene llanta de repuesto?'), false);
    await runTimers();
    assert.equal(wa.sent[1]!.jid, ME);
  });

  it('descarta la respuesta si el comprador escribió de nuevo mientras la IA pensaba', async () => {
    responder.during = () => seller.handle(buyer('Ah, y ¿cuántos dueños ha tenido?'), false);
    seller.handle(buyer('Hola'), false);
    await runTimers();
    assert.equal(wa.sent.length, 0, 'la primera respuesta se descarta');
    responder.during = null;
    await runTimers();
    assert.equal(wa.sent.length, 1);
    assert.deepEqual(
      responder.calls[1]!.turns.map((t) => t.text),
      ['Hola', 'Ah, y ¿cuántos dueños ha tenido?'],
    );
  });

  it('no responde con el modo apagado, en grupos, en el historial, a mensajes viejos ni a tu número', async () => {
    setSeller({ enabled: false });
    seller.handle(buyer('Hola'), false);
    setSeller({});
    seller.handle(buyer('Hola', { jid: GROUP, isGroup: true }), false);
    seller.handle(buyer('Hola', { live: false }), false);
    seller.handle(buyer('Hola', { ts: NOW - 7 * 3600 }), false);
    seller.handle(buyer('Hola', { jid: OWNER_JID, altJid: null }), false);
    seller.handle(buyer('Hola'), true);
    assert.equal(timers.size, 0);
    await runTimers();
    assert.equal(wa.sent.length, 0);
  });

  it('respeta el tope de respuestas por chat y te avisa', async () => {
    repo.touchSellerChat(BUYER, BUYER_LID, NOW);
    for (let i = 0; i < 15; i += 1) repo.addSellerMessage(BUYER, 'bot', `respuesta ${i}`, NOW - 60, `old-${i}`);
    seller.handle(buyer('Hola otra vez'), false);
    await runTimers();
    assert.equal(responder.calls.length, 0);
    assert.equal(wa.sent.length, 1);
    assert.equal(wa.sent[0]!.jid, OWNER_JID);
    assert.equal(repo.getSellerChat(BUYER)!.pause_reason, 'limit');
  });

  it('si WhatsApp está desconectado, reintenta más tarde', async () => {
    wa.connected = false;
    seller.handle(buyer('Hola'), false);
    await runTimers();
    assert.equal(wa.sent.length, 0);
    assert.equal(timers.size, 1, 'queda programado un reintento');
    wa.connected = true;
    await runTimers();
    assert.equal(wa.sent.length, 1);
  });

  it('al reconectar, contesta los chats que quedaron sin respuesta', async () => {
    repo.touchSellerChat(BUYER, BUYER_LID, NOW);
    repo.addSellerMessage(BUYER, 'buyer', 'Hola, ¿sigue en venta?', NOW - 600, 'x1');
    seller.resumePending();
    assert.equal(timers.size, 1);
    await runTimers();
    assert.equal(wa.sent.length, 1);
  });

  it('pausar a mano desde el dashboard', async () => {
    seller.handle(buyer('Hola'), false);
    seller.pause(BUYER);
    assert.equal(timers.size, 0);
    assert.equal(repo.getSellerChat(BUYER)!.pause_reason, 'manual');
  });

  it('el estado explica qué falta', () => {
    assert.equal(seller.status().ready, true);
    setSeller({ instructions: '' });
    assert.match(seller.status().problem!, /instrucciones/);
    const sinClave = new Seller({
      repo,
      wa,
      logger: pino({ level: 'silent' }),
      responder: null,
      timezone: 'America/Bogota',
      publicUrl: '',
    });
    assert.match(sinClave.status().problem!, /ANTHROPIC_API_KEY/);
  });
});

describe('Conversación para la IA', () => {
  it('empieza en el primer mensaje del comprador, junta mensajes seguidos y marca los tuyos', () => {
    const messages = buildMessages([
      { role: 'bot', text: 'mensaje viejo' },
      { role: 'buyer', text: 'Hola' },
      { role: 'buyer', text: '¿Precio?' },
      { role: 'bot', text: '$63.900.000' },
      { role: 'owner', text: 'Te lo muestro el sábado' },
      { role: 'buyer', text: 'Listo' },
    ]);
    assert.deepEqual(messages, [
      { role: 'user', content: 'Hola\n¿Precio?' },
      { role: 'assistant', content: '$63.900.000\n[Escrito por quien vende] Te lo muestro el sábado' },
      { role: 'user', content: 'Listo' },
    ]);
  });

  it('no hay nada que responder si el último mensaje no es del comprador', () => {
    assert.equal(buildMessages([{ role: 'buyer', text: 'Hola' }, { role: 'bot', text: 'Hola!' }]), null);
    assert.equal(buildMessages([{ role: 'bot', text: 'Hola!' }]), null);
    assert.equal(buildMessages([]), null);
  });
});

describe('Avisos', () => {
  it('muestra el número solo cuando WhatsApp lo da', () => {
    assert.equal(phoneOf(BUYER), '+573101234567');
    assert.equal(phoneOf(BUYER_LID), null);
    const text = alertText({
      kind: 'handoff',
      name: null,
      jid: BUYER_LID,
      reason: 'Quiere visita el sábado',
      summary: '',
      lastBuyerText: '¿El sábado a las 10?',
      pauseHours: 24,
      publicUrl: '',
    });
    assert.match(text, /Comprador sin nombre/);
    assert.match(text, /«¿El sábado a las 10\?»/);
    assert.doesNotMatch(text, /Para volver a activarlo/);
  });

  it('el "escribiendo…" dura entre 1,5 y 7 segundos', () => {
    assert.equal(typingDelayMs(''), 1500);
    assert.equal(typingDelayMs('x'.repeat(1000)), 7000);
  });
});
