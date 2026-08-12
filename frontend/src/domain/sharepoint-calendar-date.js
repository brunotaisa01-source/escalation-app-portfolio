import { zonedMidnight } from './calendar-age.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const UK_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function londonCalendarDate(value) {
  if (value === null || value === undefined || value === '') return '';
  const raw = String(value).trim();
  const input = parseCalendarDateInput(raw);
  if (input) return input;
  const isoPrefix = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(raw);
  if (isoPrefix && !isValidCalendarDate(isoPrefix[1])) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function parseCalendarDateInput(value) {
  const raw = String(value ?? '').trim();
  if (DATE_ONLY.test(raw)) return isValidCalendarDate(raw) ? raw : null;
  const match = UK_DATE.exec(raw);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  return isValidCalendarDate(iso) ? iso : null;
}

function isValidCalendarDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function shiftedIso(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function londonDateRange(value) {
  const iso = parseCalendarDateInput(value);
  if (!iso) return null;
  const start = zonedMidnight(`${iso}T12:00:00Z`);
  const end = zonedMidnight(`${shiftedIso(iso, 1)}T12:00:00Z`);
  return start && end ? { iso, start, end } : null;
}

export function sharePointValueMatches(expected, actual, field) {
  if (['DocDate', 'EscalationDate', 'DateResolved'].includes(field)) {
    return londonCalendarDate(expected) === londonCalendarDate(actual);
  }
  return String(expected ?? '') === String(actual ?? '');
}
