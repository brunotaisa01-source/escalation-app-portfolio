import { londonCalendarDate } from './sharepoint-calendar-date.js';

function serialDay(value) {
  const iso = londonCalendarDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [year, month, day] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function isWeekday(serial) {
  const day = new Date(serial * 86400000).getUTCDay();
  return day !== 0 && day !== 6;
}

function networkDays(start, end) {
  const direction = start <= end ? 1 : -1;
  let count = 0;
  for (let day = start; ; day += direction) {
    if (isWeekday(day)) count += direction;
    if (day === end) return count;
  }
}

export function deriveDaysToResolve(receivedDateTime, dateResolved) {
  if (!receivedDateTime || !dateResolved) return null;
  const start = serialDay(receivedDateTime);
  const end = serialDay(dateResolved);
  if (start === null || end === null || end < start) return null;
  return networkDays(start, end) - 1;
}
