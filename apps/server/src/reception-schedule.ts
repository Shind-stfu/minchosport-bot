import type { AppDatabase } from './database.js';

export type ReceptionSchedule = { startTime: string; endTime: string; timeZone: string };

export const DEFAULT_RECOVERY_SCHEDULE: ReceptionSchedule = { startTime: '16:00', endTime: '19:00', timeZone: 'America/Bogota' };

export function readReceptionSchedule(db: AppDatabase, sessionId: string): ReceptionSchedule {
  return db.prepare('SELECT reception_start_time as startTime,reception_end_time as endTime,reception_timezone as timeZone FROM whatsapp_session_settings WHERE session_id=?')
    .get(sessionId) as ReceptionSchedule | undefined ?? DEFAULT_RECOVERY_SCHEDULE;
}

function timeMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('La hora debe tener el formato HH:mm.');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error('La hora configurada no es válida.');
  return hours * 60 + minutes;
}

export function localMinuteOfDay(timestampMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestampMs);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour * 60 + minute;
}

export function isReceptionOpen(timestampMs: number, schedule: ReceptionSchedule): boolean {
  const start = timeMinutes(schedule.startTime);
  const end = timeMinutes(schedule.endTime);
  if (start === end) throw new Error('La hora de inicio y fin de recepción deben ser distintas.');
  const current = localMinuteOfDay(timestampMs, schedule.timeZone);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function localDayNumber(timestampMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestampMs);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000;
}

/** Match original send time against today's range, never yesterday's matching clock hours. */
export function isInRecoveryWindow(timestampMs: number, schedule: ReceptionSchedule, nowMs = Date.now()): boolean {
  if (!Number.isFinite(timestampMs) || timestampMs > nowMs || !isReceptionOpen(timestampMs, schedule)) return false;
  const crossesMidnight = timeMinutes(schedule.startTime) > timeMinutes(schedule.endTime);
  const referenceDay = localDayNumber(nowMs, schedule.timeZone)
    - (crossesMidnight && localMinuteOfDay(nowMs, schedule.timeZone) < timeMinutes(schedule.startTime) ? 1 : 0);
  const messageDay = localDayNumber(timestampMs, schedule.timeZone)
    - (crossesMidnight && localMinuteOfDay(timestampMs, schedule.timeZone) < timeMinutes(schedule.endTime) ? 1 : 0);
  return messageDay === referenceDay;
}

