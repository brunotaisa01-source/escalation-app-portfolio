import { calendarDayAge } from './calendar-age.js';
import { formatEscalationId, parseEscalationId } from './escalation-id.js';
import { londonCalendarDate, parseCalendarDateInput } from './sharepoint-calendar-date.js';
import { isVendorConfirmed, isVendorUnmatched } from './vendor-match.js';
import { isOpenStatus, matchesStatusView } from './status-policy.js';

function text(value) {
  return String(value ?? '').trim();
}

function selectedValues(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(values.map(text).filter(Boolean));
}

function statusMatches(item, { status = 'All', statuses = [] } = {}) {
  const selected = selectedValues(statuses);
  if (selected.size) return selected.has(item.Status);
  if (status === 'Open' || status === 'Closed' || status === 'All' || status === 'None') {
    return matchesStatusView(item.Status, status);
  }
  return matchesStatusView(item.Status, status);
}

function globalTextMatches(item, query) {
  const needle = text(query).toLocaleLowerCase();
  if (!needle) return true;
  return [item.Title, item.Vendor, item.Reference, item.From]
    .some((value) => String(value ?? '').toLocaleLowerCase().includes(needle));
}

function numericMatches(candidate, entry) {
  if (!Number.isFinite(candidate)) return false;
  const operator = entry?.operator ?? 'equals';
  if (operator === 'between') {
    const from = Number(entry?.from);
    const to = Number(entry?.to);
    return Number.isFinite(from) && Number.isFinite(to) && candidate >= from && candidate <= to;
  }
  const expected = Number(entry?.value);
  if (!Number.isFinite(expected)) return true;
  return ({
    equals: candidate === expected,
    lt: candidate < expected,
    lte: candidate <= expected,
    gt: candidate > expected,
    gte: candidate >= expected,
  })[operator] ?? true;
}

function dateMatches(value, entry) {
  const candidate = londonCalendarDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  const operator = entry?.operator ?? 'on';
  const from = parseCalendarDateInput(entry?.from ?? entry?.value);
  const to = parseCalendarDateInput(entry?.to ?? entry?.value);
  if (!from) return true;
  if (operator === 'between') return Boolean(to) && candidate >= from && candidate <= to;
  if (operator === 'on') return candidate === from;
  if (operator === 'before') return candidate < from;
  if (operator === 'after') return candidate > from;
  if (operator === 'gte') return candidate >= from;
  if (operator === 'lte') return candidate <= from;
  return true;
}

function friendlyIdMatches(item, entry) {
  const visible = formatEscalationId(item).toLocaleLowerCase();
  const expected = text(entry?.value).toLocaleLowerCase();
  if (!expected) return true;
  if (entry?.operator !== 'equals') return visible.includes(expected);
  const parsed = parseEscalationId(entry?.value);
  if (!parsed || Number(item.id) !== parsed.id) return false;
  const received = new Date(item.ReceivedDateTime);
  return !Number.isNaN(received.getTime()) && received.getUTCFullYear() === parsed.year;
}

function columnValue(item, field) {
  if (field === 'ReferenceOrSubject') return [item.Reference, item.Title];
  if (field === 'Age') return calendarDayAge(item.ReceivedDateTime);
  if (field === 'EscalationId') return item.id;
  return item?.[field];
}

function columnMatches(item, field, entry) {
  const kind = entry?.kind ?? (Array.isArray(entry) ? 'categorical' : 'text');
  if (kind === 'friendly-id' || field === 'EscalationId') return friendlyIdMatches(item, entry);
  const value = columnValue(item, field);
  if (kind === 'categorical') {
    const allowed = selectedValues(Array.isArray(entry) ? entry : entry?.values);
    return !allowed.size || allowed.has(text(value));
  }
  if (kind === 'text') {
    const expected = text(entry?.value).toLocaleLowerCase();
    if (!expected) return true;
    const candidates = Array.isArray(value) ? value : [value];
    return candidates.some((candidate) => {
      const comparable = String(candidate ?? '').toLocaleLowerCase();
      return entry?.operator === 'equals' ? comparable === expected : comparable.includes(expected);
    });
  }
  if (kind === 'number') return numericMatches(Number(value), entry);
  if (kind === 'age') return numericMatches(Number(value), entry);
  if (kind === 'date') return dateMatches(value, entry);
  return true;
}

export function matchesCaseRequest(item, request = {}) {
  const priorities = selectedValues([...(Array.isArray(request.priorities) ? request.priorities : [request.priorities]), request.priority]);
  const sourceQueues = selectedValues(request.sourceQueues);
  if (!statusMatches(item, request) || !globalTextMatches(item, request.query)) return false;
  if (priorities.size && !priorities.has(text(item.Priority))) return false;
  if (sourceQueues.size && !sourceQueues.has(text(item.SourceQueue))) return false;
  if (request.vendor && item.Vendor !== request.vendor && item.VendorName !== request.vendor) return false;
  if (request.vendorMatched === true && !isVendorConfirmed(item)) return false;
  if (request.vendorMatched === false && !isVendorUnmatched(item)) return false;
  if (request.receivedBefore && (!item.ReceivedDateTime || String(item.ReceivedDateTime) >= String(request.receivedBefore))) return false;
  return Object.entries(request.columnFilters ?? {}).every(([field, entry]) => columnMatches(item, field, entry));
}

export const OPEN_STATUSES = Object.freeze({ has: isOpenStatus });
