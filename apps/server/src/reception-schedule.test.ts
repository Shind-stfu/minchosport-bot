import { describe, expect, it } from 'vitest';
import { isInRecoveryWindow, isReceptionOpen } from './reception-schedule.js';

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

  it.each(['18:00', '19:00'])('at 7 p.m. recovers only today from 4 p.m. until %s by original send time', (endTime) => {
    const range = { startTime: '16:00', endTime, timeZone: 'America/Bogota' };
    const now = Date.parse('2026-10-22T19:00:00-05:00');
    const eligible = (date: string) => isInRecoveryWindow(Date.parse(date), range, now);
    expect(eligible('2026-10-22T15:59:59-05:00')).toBe(false);
    expect(eligible('2026-10-22T16:00:00-05:00')).toBe(true);
    expect(eligible('2026-10-22T17:59:59-05:00')).toBe(true);
    expect(eligible('2026-10-22T18:30:00-05:00')).toBe(endTime === '19:00');
    expect(eligible(`2026-10-22T${endTime}:00-05:00`)).toBe(false);
    expect(eligible('2026-10-21T17:00:00-05:00')).toBe(false);
    expect(eligible('2026-10-23T17:00:00-05:00')).toBe(false);
  });

  it('uses the Colombian date near UTC midnight and rejects invalid or future timestamps', () => {
    const now = Date.parse('2026-10-23T00:00:00Z'); // 7 p.m. on October 22 in Colombia
    const range = { startTime: '16:00', endTime: '19:00', timeZone: 'America/Bogota' };
    expect(isInRecoveryWindow(Date.parse('2026-10-22T22:00:00Z'), range, now)).toBe(true);
    expect(isInRecoveryWindow(Number.NaN, range, now)).toBe(false);
    expect(isInRecoveryWindow(now + 1000, range, now)).toBe(false);
  });

  it('anchors a range crossing midnight to the most recent starting date', () => {
    const range = { startTime: '22:00', endTime: '06:00', timeZone: 'America/Bogota' };
    const now = Date.parse('2026-10-23T07:00:00-05:00');
    expect(isInRecoveryWindow(Date.parse('2026-10-22T23:00:00-05:00'), range, now)).toBe(true);
    expect(isInRecoveryWindow(Date.parse('2026-10-23T05:59:59-05:00'), range, now)).toBe(true);
    expect(isInRecoveryWindow(Date.parse('2026-10-22T05:00:00-05:00'), range, now)).toBe(false);
  });
});
