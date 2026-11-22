import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, monthStartKey, nextTrackingSinceDate, sanitizeSettings } from './settings.js';

describe('Fecha de inicio', () => {
  it('por defecto cuenta solo el mes en curso', () => {
    assert.equal(defaultSettings.trackingSinceMode, 'month');
    assert.equal(sanitizeSettings({}).trackingSinceMode, 'month', 'ajustes guardados sin el campo pasan a mes en curso');
    assert.equal(sanitizeSettings({ trackingSinceMode: 'fixed' }).trackingSinceMode, 'fixed');
  });

  it('monthStartKey da el día 1 del mes', () => {
    assert.equal(monthStartKey('2026-11-22'), '2026-11-01');
    assert.equal(monthStartKey('2026-12-01'), '2026-12-01');
  });

  it('en modo mes mueve la fecha al día 1 y avanza al cambiar de mes', () => {
    const s = { ...defaultSettings, trackingSinceDate: '2026-10-23' };
    assert.equal(nextTrackingSinceDate(s, '2026-11-22', '2026-10-23'), '2026-11-01');
    const nov = { ...s, trackingSinceDate: '2026-11-01' };
    assert.equal(nextTrackingSinceDate(nov, '2026-11-30', 'x'), null, 'mismo mes: no cambia');
    assert.equal(nextTrackingSinceDate(nov, '2026-12-01', 'x'), '2026-12-01');
  });

  it('en modo fijo solo se pone una vez', () => {
    const s = { ...defaultSettings, trackingSinceMode: 'fixed' as const, trackingSinceDate: null };
    assert.equal(nextTrackingSinceDate(s, '2026-11-22', '2026-10-23'), '2026-10-23');
    assert.equal(nextTrackingSinceDate({ ...s, trackingSinceDate: '2026-09-15' }, '2026-12-05', 'x'), null);
  });
});
