export type ReceptionSchedule = { startTime: string; endTime: string; timeZone: string };

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

