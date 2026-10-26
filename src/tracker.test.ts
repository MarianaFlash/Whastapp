import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Repo } from './db.js';
import { defaultSettings, type Settings } from './settings.js';
import { Tracker, type MessageEvent } from './tracker.js';

const MAMA = '573001112233@s.whatsapp.net';
const GRUPO = '120363000000000000@g.us';

let repo: Repo;
let settings: Settings;
let tracker: Tracker;
let seq = 0;

function ev(partial: Partial<MessageEvent> & { ts: number; fromMe: boolean }): MessageEvent {
  seq += 1;
  return {
    id: `msg-${seq}`,
    jid: MAMA,
    isGroup: false,
    kind: 'message',
    preview: 'hola',
    ...partial,
  };
}

beforeEach(() => {
  repo = new Repo(':memory:');
  settings = { ...defaultSettings };
  tracker = new Tracker(repo, () => settings);
});

describe('Tracker', () => {
  it('un mensaje entrante abre una espera y mi respuesta la cierra', () => {
    const r1 = tracker.handle(ev({ ts: 1000, fromMe: false, name: 'Mamá' }));
    assert.equal(r1.started, true);
    assert.equal(r1.chat.waiting_since, 1000);
    assert.equal(r1.chat.name, 'Mamá');

    const r2 = tracker.handle(ev({ ts: 1100, fromMe: false, preview: 'me llamas?' }));
    assert.equal(r2.started, false);
    assert.equal(r2.chat.unanswered_count, 2);
    assert.equal(r2.chat.preview, 'me llamas?');

    const r3 = tracker.handle(ev({ ts: 4000, fromMe: true }));
    assert.equal(r3.resolved, true);
    assert.equal(r3.chat.waiting_since, null);
    assert.equal(r3.chat.unanswered_count, 0);

    const responses = repo.responsesSince(0);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].wait_seconds, 3000);
    assert.equal(responses[0].resolved_by, 'reply');
  });

  it('ignora mensajes repetidos (mismo id)', () => {
    tracker.handle({ ...ev({ ts: 1000, fromMe: false }), id: 'dup' });
    const again = tracker.handle({ ...ev({ ts: 1000, fromMe: false }), id: 'dup' });
    assert.equal(again.skipped, true);
    assert.equal(again.chat.unanswered_count, 1);
  });

  it('un mensaje entrante anterior a mi última respuesta no abre espera', () => {
    tracker.handle(ev({ ts: 5000, fromMe: true }));
    const r = tracker.handle(ev({ ts: 4000, fromMe: false }));
    assert.equal(r.started, false);
    assert.equal(r.chat.waiting_since, null);
  });

  it('mi reacción cuenta como respuesta si está activado', () => {
    tracker.handle(ev({ ts: 1000, fromMe: false }));
    const r = tracker.handle(ev({ ts: 1500, fromMe: true, kind: 'reaction' }));
    assert.equal(r.resolved, true);

    settings = { ...defaultSettings, reactionCountsAsReply: false };
    tracker.handle(ev({ ts: 2000, fromMe: false }));
    const r2 = tracker.handle(ev({ ts: 2500, fromMe: true, kind: 'reaction' }));
    assert.equal(r2.resolved, false);
    assert.equal(r2.chat.waiting_since, 2000);
  });

  it('en grupos solo cuenta si me mencionan (modo mentions)', () => {
    const plain = tracker.handle(ev({ jid: GRUPO, isGroup: true, ts: 1000, fromMe: false }));
    assert.equal(plain.chat.waiting_since, null);
    const mention = tracker.handle(ev({ jid: GRUPO, isGroup: true, ts: 1100, fromMe: false, mentionsMe: true }));
    assert.equal(mention.started, true);

    settings = { ...defaultSettings, groupsMode: 'ignore' };
    const other = tracker.handle(ev({ jid: '1203630000000001@g.us', isGroup: true, ts: 1200, fromMe: false, mentionsMe: true }));
    assert.equal(other.chat.waiting_since, null);
  });

  it('resolver manualmente cierra la espera sin contar como respuesta', () => {
    tracker.handle(ev({ ts: 1000, fromMe: false }));
    const chat = tracker.resolveManually(MAMA, 9000);
    assert.equal(chat?.waiting_since, null);
    const responses = repo.responsesSince(0);
    assert.equal(responses[0].resolved_by, 'manual');
  });

  it('une el jid de teléfono y el LID en un solo chat', () => {
    tracker.handle(ev({ ts: 1000, fromMe: false, jid: MAMA, altJid: '999@lid' }));
    const r = tracker.handle(ev({ ts: 2000, fromMe: true, jid: '999@lid' }));
    assert.equal(r.resolved, true);
    assert.equal(repo.listChats().length, 1);
  });

  it('ignora por completo los mensajes anteriores a la fecha de inicio', () => {
    settings = { ...defaultSettings, trackingSinceDate: '2026-10-01' };
    const cutoff = Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000);
    const old = tracker.handle(ev({ ts: cutoff - 86400, fromMe: false }));
    assert.equal(old.skipped, true);
    assert.equal(old.chat.waiting_since, null);
    const recent = tracker.handle(ev({ ts: cutoff + 86400, fromMe: false }));
    assert.equal(recent.started, true);
    // Mucho después sigue contando: no hay ventana móvil.
    const later = tracker.handle(ev({ jid: '573009990000@s.whatsapp.net', ts: cutoff + 400 * 86400, fromMe: false }));
    assert.equal(later.started, true);
  });

  it('applyStartDate limpia esperas viejas ya guardadas', () => {
    // Historial sincronizado sin fecha de inicio: tres chats con esperas antiguas.
    tracker.handle(ev({ jid: 'viejo@s.whatsapp.net', ts: 1_000, fromMe: false, preview: 'hola?' }));
    tracker.handle(ev({ jid: 'mixto@s.whatsapp.net', ts: 1_000, fromMe: false }));
    tracker.handle(ev({ jid: 'mixto@s.whatsapp.net', ts: 90_000, fromMe: false, preview: 'sigues ahí?' }));
    tracker.handle(ev({ jid: GRUPO, isGroup: true, ts: 1_000, fromMe: false, mentionsMe: true }));
    tracker.handle(ev({ jid: GRUPO, isGroup: true, ts: 90_000, fromMe: false }));
    tracker.handle(ev({ jid: 'nuevo@s.whatsapp.net', ts: 95_000, fromMe: false }));
    assert.equal(repo.listWaiting().length, 4);

    // Se fija la fecha de inicio: 1970-01-02 = 86 400 s.
    settings = { ...defaultSettings, trackingSinceDate: '1970-01-02' };
    const touched = tracker.applyStartDate(100_000);
    assert.equal(touched, 3);

    assert.equal(repo.getChat('viejo@s.whatsapp.net')?.waiting_since, null, 'sin mensajes después de la fecha: se cierra');
    assert.equal(repo.getChat('viejo@s.whatsapp.net')?.preview, null);
    const mixto = repo.getChat('mixto@s.whatsapp.net');
    assert.equal(mixto?.waiting_since, 90_000, 'con mensajes después de la fecha: la espera se reinicia desde el último');
    assert.equal(mixto?.unanswered_count, 1);
    assert.equal(mixto?.preview, 'sigues ahí?');
    assert.equal(repo.getChat(GRUPO)?.waiting_since, null, 'los grupos se cierran, no se sabe si la mención fue después');
    assert.equal(repo.getChat('nuevo@s.whatsapp.net')?.waiting_since, 95_000, 'las esperas posteriores no se tocan');
    assert.equal(repo.responsesSince(0).length, 0, 'no cuenta como respuestas');

    assert.equal(tracker.applyStartDate(100_001), 0, 'volver a ejecutarlo no cambia nada');
  });

  it('un mensaje nuevo quita la posposición', () => {
    tracker.handle(ev({ ts: 1000, fromMe: false }));
    repo.setSnooze(MAMA, 999_999, 1000);
    tracker.handle(ev({ ts: 1100, fromMe: false }));
    assert.equal(repo.getChat(MAMA)?.snoozed_until, 999_999, 'un mensaje más dentro de la misma espera no toca la posposición');
    tracker.handle(ev({ ts: 1200, fromMe: true }));
    tracker.handle(ev({ ts: 1300, fromMe: false }));
    assert.equal(repo.getChat(MAMA)?.snoozed_until, null, 'una espera nueva empieza sin posposición');
  });
});
