import { describe, expect, it } from 'vitest';
import { isReceptionOpen } from './reception-schedule.js';

describe('per-account reception window', () => {
  const schedule = { startTime: '09:00', endTime: '21:00', timeZone: 'America/Bogota' };

  it('uses Colombia local time for the daily 9 a.m. to 9 p.m. window', () => {
    expect(isReceptionOpen(Date.parse('2026-10-20T04:59:00.000Z'), schedule)).toBe(false); // 11:59 p.m.
    expect(isReceptionOpen(Date.parse('2026-10-20T14:00:00.000Z'), schedule)).toBe(true); // 9:00 a.m.
    expect(isReceptionOpen(Date.parse('2026-10-21T01:59:00.000Z'), schedule)).toBe(true); // 8:59 p.m.
    expect(isReceptionOpen(Date.parse('2026-10-21T02:00:00.000Z'), schedule)).toBe(false); // 9:00 p.m.
  });

  it('supports a configured window that crosses midnight and rejects an empty one', () => {
    expect(isReceptionOpen(Date.parse('2026-10-20T06:00:00.000Z'), { startTime: '22:00', endTime: '06:00', timeZone: 'America/Bogota' })).toBe(true);
    expect(isReceptionOpen(Date.parse('2026-10-20T13:00:00.000Z'), { startTime: '22:00', endTime: '06:00', timeZone: 'America/Bogota' })).toBe(false);
    expect(() => isReceptionOpen(Date.now(), { startTime: '09:00', endTime: '09:00', timeZone: 'America/Bogota' })).toThrow(/distintas/);
  });
});
