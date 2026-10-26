import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareUrgency, formatDuration, isQuietHours, levelFor, localHHMM, toChatView } from './status.js';
import { defaultSettings } from './settings.js';
import type { ChatRow } from './db.js';

const thresholds = { yellow: 30, red: 120, critical: 360 };

describe('levelFor', () => {
  it('escala por minutos de espera', () => {
    assert.equal(levelFor(10 * 60, thresholds), 'ok');
    assert.equal(levelFor(30 * 60, thresholds), 'yellow');
    assert.equal(levelFor(119 * 60, thresholds), 'yellow');
    assert.equal(levelFor(120 * 60, thresholds), 'red');
    assert.equal(levelFor(360 * 60, thresholds), 'critical');
  });
});

describe('formatDuration', () => {
  it('formatea en español', () => {
    assert.equal(formatDuration(30), 'menos de 1 min');
    assert.equal(formatDuration(45 * 60), '45 min');
    assert.equal(formatDuration(3 * 3600 + 20 * 60), '3 h 20 min');
    assert.equal(formatDuration(2 * 3600), '2 h');
    assert.equal(formatDuration(2 * 86400 + 4 * 3600), '2 d 4 h');
  });
});

describe('isQuietHours', () => {
  const quiet = { enabled: true, start: '22:00', end: '07:00' };
  it('detecta rangos que cruzan medianoche', () => {
    // 2026-01-10 03:00 Bogotá = 08:00Z
    assert.equal(isQuietHours(new Date('2026-01-10T08:00:00Z'), quiet, 'America/Bogota'), true);
    // 23:30 Bogotá = 04:30Z del día siguiente
    assert.equal(isQuietHours(new Date('2026-01-11T04:30:00Z'), quiet, 'America/Bogota'), true);
    // 12:00 Bogotá = 17:00Z
    assert.equal(isQuietHours(new Date('2026-01-10T17:00:00Z'), quiet, 'America/Bogota'), false);
  });
  it('respeta el apagado', () => {
    assert.equal(isQuietHours(new Date('2026-01-10T08:00:00Z'), { ...quiet, enabled: false }, 'America/Bogota'), false);
  });
  it('localHHMM usa la zona horaria', () => {
    assert.equal(localHHMM(new Date('2026-01-10T17:05:00Z'), 'America/Bogota'), '12:05');
  });
});

function row(partial: Partial<ChatRow>): ChatRow {
  return {
    jid: '573001112233@s.whatsapp.net',
    alt_jid: null,
    name: 'Alguien',
    is_group: 0,
    vip_group: null,
    ignored: 0,
    last_incoming_at: null,
    last_outgoing_at: null,
    waiting_since: null,
    unanswered_count: 0,
    preview: null,
    preview_at: null,
    snoozed_until: null,
    updated_at: 0,
    ...partial,
  };
}

describe('toChatView + compareUrgency', () => {
  const now = 1_800_000_000;
  it('ordena críticos primero, luego VIP, luego quien más espera', () => {
    const vipRed = toChatView(row({ jid: 'a@s.whatsapp.net', vip_group: 'Familia', waiting_since: now - 3 * 3600 }), defaultSettings, now);
    const normalLong = toChatView(row({ jid: 'b@s.whatsapp.net', waiting_since: now - 20 * 3600 }), defaultSettings, now);
    const normalCritical = toChatView(row({ jid: 'c@s.whatsapp.net', waiting_since: now - 3 * 86400 }), defaultSettings, now);
    const snoozed = toChatView(row({ jid: 'd@s.whatsapp.net', waiting_since: now - 5 * 86400, snoozed_until: now + 3600 }), defaultSettings, now);

    assert.equal(vipRed.level, 'red');
    assert.equal(normalLong.level, 'red');
    assert.equal(normalCritical.level, 'critical');
    assert.equal(snoozed.level, 'ok');
    assert.equal(snoozed.snoozed, true);

    const sorted = [snoozed, normalLong, vipRed, normalCritical].sort(compareUrgency).map((v) => v.jid);
    assert.deepEqual(sorted, ['c@s.whatsapp.net', 'a@s.whatsapp.net', 'b@s.whatsapp.net', 'd@s.whatsapp.net']);
  });
  it('una espera larga sigue contando sin límite de días', () => {
    const old = row({ jid: 'e@s.whatsapp.net', waiting_since: now - 90 * 86400 });
    const view = toChatView(old, defaultSettings, now);
    assert.equal(view.pending, true);
    assert.equal(view.level, 'critical');
  });
  it('genera el enlace wa.me desde el teléfono', () => {
    const view = toChatView(row({ jid: '573001112233@s.whatsapp.net' }), defaultSettings, now);
    assert.equal(view.waLink, 'https://wa.me/573001112233');
    const lid = toChatView(row({ jid: '12345@lid', alt_jid: '573009998877@s.whatsapp.net' }), defaultSettings, now);
    assert.equal(lid.waLink, 'https://wa.me/573009998877');
  });
});
