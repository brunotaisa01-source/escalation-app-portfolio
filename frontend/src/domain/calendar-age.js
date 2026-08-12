export const AGE_TIME_ZONE = 'Europe/London';

const formatterCache = new Map();

function formatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }));
  }
  return formatterCache.get(timeZone);
}

function zonedParts(value, timeZone = AGE_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

function dateOnly(parts, dayOffset = 0) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

export function zonedMidnight(value, dayOffset = 0, timeZone = AGE_TIME_ZONE) {
  const base = zonedParts(value, timeZone);
  if (!base) return null;
  const target = dateOnly(base, dayOffset);
  const targetUtc = Date.UTC(target.year, target.month - 1, target.day, 0, 0, 0);
  let guess = targetUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(new Date(guess), timeZone);
    const observedUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const delta = targetUtc - observedUtc;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess);
}

export function calendarDayAge(received, now = new Date(), timeZone = AGE_TIME_ZONE) {
  const receivedParts = zonedParts(received, timeZone);
  const nowParts = zonedParts(now, timeZone);
  if (!receivedParts || !nowParts) return null;
  const receivedDay = Date.UTC(receivedParts.year, receivedParts.month - 1, receivedParts.day);
  const currentDay = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  return Math.max(0, Math.round((currentDay - receivedDay) / 86400000));
}

function asODataDate(date) {
  return `datetime'${date.toISOString()}'`;
}

export function buildAgeODataClause(field, entry = {}, now = new Date(), timeZone = AGE_TIME_ZONE) {
  const operator = entry.operator ?? 'equals';
  if (operator === 'between') {
    const from = Number(entry.from);
    const to = Number(entry.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) return null;
    const lower = zonedMidnight(now, -to, timeZone);
    const upper = zonedMidnight(now, -from + 1, timeZone);
    return `(${field} ge ${asODataDate(lower)} and ${field} lt ${asODataDate(upper)})`;
  }
  const days = Number(entry.value);
  if (!Number.isFinite(days) || days < 0) return null;
  const start = zonedMidnight(now, -days, timeZone);
  const next = zonedMidnight(now, -days + 1, timeZone);
  if (operator === 'equals') return `(${field} ge ${asODataDate(start)} and ${field} lt ${asODataDate(next)})`;
  if (operator === 'lt') return `${field} ge ${asODataDate(zonedMidnight(now, -Math.max(0, days - 1), timeZone))}`;
  if (operator === 'lte') return `${field} ge ${asODataDate(start)}`;
  if (operator === 'gt') return `${field} lt ${asODataDate(start)}`;
  if (operator === 'gte') return `${field} lt ${asODataDate(next)}`;
  return null;
}
