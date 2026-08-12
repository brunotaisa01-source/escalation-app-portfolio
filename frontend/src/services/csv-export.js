import { formatEscalationId } from '../domain/escalation-id.js';
import { calendarDayAge } from '../domain/calendar-age.js';

export const CSV_COLUMNS = Object.freeze([
  ['Escalation ID', (item) => formatEscalationId(item)],
  ['Status', 'Status'],
  ['Received', 'ReceivedDateTime'],
  ['Age (days)', (item, { now }) => {
    const age = calendarDayAge(item.ReceivedDateTime, now);
    return age === null ? '' : age;
  }],
  ['Source Queue', 'SourceQueue'],
  ['Mailbox', 'Mailbox'],
  ['From', 'From'],
  ['Reference / Subject', (item) => [item.Reference, item.Title].filter(Boolean).join(' / ')],
  ['Vendor', 'Vendor'],
  ['Vendor Name', 'VendorName'],
  ['Category', 'VendorCategory'],
  ['Entity', 'Entity'],
  ['Doc Date', 'DocDate'],
  ['Invoice Ref', 'InvRef'],
  ['Value', 'Value'],
  ['AP Owner', 'APOwner'],
  ['Priority', 'Priority'],
  ['Action Type', 'ActionType'],
  ['Escalation Date', 'EscalationDate'],
  ['Working Notes', 'WorkingNotes'],
  ['Date Resolved', 'DateResolved'],
  ['Days To Resolve', 'DaysToResolve'],
]);

export function neutraliseSpreadsheetFormula(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  const text = String(value);
  const trimmed = text.trimStart();
  if (!trimmed) return text;
  if (/^-[0-9]+(?:[.,][0-9]+)?(?:e[+-]?[0-9]+)?$/i.test(trimmed)) return text;
  return /^[=+@-]/.test(trimmed) ? `'${text}` : text;
}

function csvCell(value) {
  const text = neutraliseSpreadsheetFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function columnValue(item, selector, options) {
  const value = typeof selector === 'function' ? selector(item, options) : item?.[selector];
  if (value instanceof Date) return value.toISOString();
  return value ?? '';
}

export function buildEscalationCsv(rows = [], { now = new Date() } = {}) {
  const header = CSV_COLUMNS.map(([label]) => csvCell(label)).join(',');
  const body = rows.map((item) => CSV_COLUMNS.map(([, selector]) => csvCell(columnValue(item, selector, { now }))).join(','));
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}

function timestamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
}

export function downloadEscalationCsv(rows = [], {
  BlobCtor = globalThis.Blob,
  documentRef = globalThis.document,
  urlApi = globalThis.URL,
  now = new Date(),
} = {}) {
  if (typeof BlobCtor !== 'function' || !documentRef?.createElement || !urlApi?.createObjectURL) {
    throw new Error('CSV download is unavailable in this browser');
  }
  const blob = new BlobCtor([buildEscalationCsv(rows, { now })], { type: 'text/csv;charset=utf-8' });
  const url = urlApi.createObjectURL(blob);
  const filename = `DEMO_Escalations_${timestamp(now)}.csv`;
  const anchor = documentRef.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  try {
    documentRef.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    urlApi.revokeObjectURL(url);
  }
  return { blob, filename };
}
