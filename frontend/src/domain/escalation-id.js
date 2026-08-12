function stableYear(item = {}) {
  const candidate = item.ReceivedDateTime ?? item.Created ?? '';
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? '0000' : String(date.getUTCFullYear()).padStart(4, '0');
}

export function formatEscalationId(item = {}) {
  const id = Number(item.id ?? item.Id ?? item.ID);
  if (!Number.isSafeInteger(id) || id < 1) return 'ESC-0000-UNKNOWN';
  return `ESC-${stableYear(item)}-${String(id).padStart(6, '0')}`;
}

export function parseEscalationId(value) {
  const match = String(value ?? '').trim().toUpperCase().match(/^ESC-(\d{4})-(\d+)$/);
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return { year: Number(match[1]), id };
}
