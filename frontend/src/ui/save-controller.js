import { dateInputValue, FIELD_LABELS, textValue } from './workbench-view.js';
import { deriveDaysToResolve } from '../domain/case-duration.js';
import { isClosedStatus, isOpenStatus } from '../domain/status-policy.js';
import { formatEscalationId } from '../domain/escalation-id.js';

export const REQUIRED_SAVE_FIELDS = Object.freeze([
  'ActionType', 'Status', 'Priority', 'WorkingNotes', 'DateResolved', 'APOwner', 'Entity',
]);

export function missingRequiredFields(draft = {}) {
  if (draft.Status === 'Duplicate') return [];
  return REQUIRED_SAVE_FIELDS.filter((field) => {
    if (field === 'Status') return !['Action Required', 'In Progress', 'Closed', 'Duplicate'].includes(draft.Status);
    return !textValue(draft[field]);
  });
}

const DUPLICATE_FIELDS = Object.freeze(['Status', 'WorkingNotes', 'DateResolved', 'DaysToResolve', 'IsClosed']);

function appendDuplicateNote(notes) {
  const value = String(notes ?? '');
  if (value.split(/\r?\n/).includes('Duplicate')) return value;
  return value ? `${value}\nDuplicate` : 'Duplicate';
}

function duplicateSnapshot(draft) {
  return Object.fromEntries(DUPLICATE_FIELDS.map((field) => [field, draft?.[field] ?? (field === 'DaysToResolve' ? null : '')]));
}

function confirmed(confirm, message) {
  return typeof confirm === 'function' && confirm(message) === true;
}

export function planStatusTransition({ base = {}, draft = {}, nextStatus, now = new Date(), confirm = globalThis.confirm, duplicateSnapshot: snapshot = null } = {}) {
  if (!['Action Required', 'In Progress', 'Closed', 'Duplicate'].includes(nextStatus)) {
    return { accepted: false, draft: { ...draft }, duplicateSnapshot: snapshot };
  }
  const working = snapshot && draft.Status === 'Duplicate' && nextStatus !== 'Duplicate'
    ? { ...draft, ...snapshot }
    : { ...draft };
  const nextSnapshot = nextStatus === 'Duplicate' ? snapshot : null;
  if (nextStatus === 'Duplicate' && base.Status !== 'Duplicate' && draft.Status !== 'Duplicate') {
    const message = `Mark ${formatEscalationId(base)} as Duplicate? It will leave Open and appear in Closed.`;
    if (!confirmed(confirm, message)) return { accepted: false, draft: { ...draft }, duplicateSnapshot: snapshot };
    const captured = duplicateSnapshot(draft);
    const resolvedAt = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString();
    return {
      accepted: true,
      duplicateSnapshot: captured,
      draft: {
        ...draft,
        Status: 'Duplicate',
        WorkingNotes: appendDuplicateNote(draft.WorkingNotes),
        DateResolved: resolvedAt,
        DaysToResolve: deriveDaysToResolve(base.ReceivedDateTime ?? draft.ReceivedDateTime, resolvedAt),
        IsClosed: true,
      },
    };
  }
  if (isClosedStatus(base.Status) && isOpenStatus(nextStatus) && base.Status !== nextStatus) {
    const message = `Reopen ${formatEscalationId(base)}? Date Resolved and Days To Resolve will be cleared.`;
    if (!confirmed(confirm, message)) return { accepted: false, draft: { ...draft }, duplicateSnapshot: snapshot };
    return {
      accepted: true,
      duplicateSnapshot: null,
      draft: { ...working, Status: nextStatus, DateResolved: '', DaysToResolve: null, IsClosed: false },
    };
  }
  return { accepted: true, duplicateSnapshot: nextSnapshot, draft: { ...working, Status: nextStatus } };
}

export function buildConflictComparison(pending = {}, server = {}, base = {}) {
  return Object.keys(pending).map((field) => {
    const comparison = {
      field,
      pendingValue: pending[field] ?? '',
      serverValue: server[field] ?? '',
    };
    if (Object.prototype.hasOwnProperty.call(base, field)) {
      comparison.baseValue = base[field] ?? '';
      comparison.sameFieldChanged = String(comparison.serverValue) !== String(comparison.baseValue);
    }
    return comparison;
  });
}

export function buildMinimalPatch(draft = {}, base = {}) {
  return Object.fromEntries(Object.entries(draft).filter(([field, value]) => {
    const dateField = ['DocDate', 'EscalationDate', 'DateResolved'].includes(field);
    const current = dateField ? dateInputValue(value) : String(value ?? '');
    const previous = dateField ? dateInputValue(base[field]) : String(base[field] ?? '');
    return current !== previous;
  }));
}

export function validateDraftForSave({ draft = {}, onInvalid = () => {} } = {}) {
  const missing = missingRequiredFields(draft);
  if (!missing.length) return true;
  const labels = missing.map((field) => FIELD_LABELS[field] ?? field);
  const message = `Complete required fields before saving: ${labels.join(', ')}`;
  missing.forEach((field) => onInvalid(message, field, missing));
  return false;
}

export function commitStatusTransition({ item, value, dateResolvedValue, draft, onInvalid = () => {} } = {}) {
  const editor = draft;
  if (!item || !editor) throw new TypeError('Status transition requires an item and draft controller');
  if (!['Action Required', 'In Progress', 'Closed', 'Duplicate'].includes(value)) {
    onInvalid('Choose Action Required, In Progress, Closed or Duplicate');
    return false;
  }
  const previousStatus = item.Status ?? '';
  if (value === 'Closed') {
    const resolved = textValue(dateResolvedValue);
    if (!resolved) {
      onInvalid('Date Resolved is required before closing this escalation');
      return false;
    }
    const previousDateResolved = item.DateResolved ?? '';
    item.Status = value;
    item.DateResolved = resolved;
    editor.change('Status', value, previousStatus);
    editor.change('DateResolved', resolved, previousDateResolved);
    return true;
  }
  item.Status = value;
  editor.change('Status', value, previousStatus);
  return true;
}

export function bindEditableControl(control, {
  getItem = () => ({}),
  setItem = () => {},
  draft,
  governedValues = {},
  onInvalid = () => {},
  onChange = () => {},
  onStatusTransition,
} = {}) {
  const editor = draft;
  if (!control || !editor) throw new TypeError('Editable control binding requires a control and draft controller');
  const eventName = control.tagName === 'SELECT' ? 'change' : 'input';
  const listener = () => {
    if (control.disabled) return;
    const field = control.dataset?.field;
    const value = control.value;
    const item = getItem() ?? {};
    const catalog = governedValues[field];
    if (catalog && value && !catalog.includes(value)) {
      onInvalid(`Choose an approved ${FIELD_LABELS[field] ?? field}`);
      return;
    }
    if (field === 'Status' && typeof onStatusTransition === 'function') {
      onStatusTransition({ item, value, control });
      setItem(item);
      return;
    }
    const previous = item[field] ?? '';
    item[field] = value;
    setItem(item);
    editor.change(field, value, previous);
    onChange({ field, value, item });
  };
  control.addEventListener(eventName, listener);
  return () => control.removeEventListener(eventName, listener);
}

export async function saveCasePatchWithReadback({ service, id, patch, etag } = {}) {
  if (!service || typeof service.update !== 'function') throw new TypeError('A case update service is required');
  if (typeof service.get !== 'function') throw new Error('Successful save requires a SharePoint readback service');
  const transaction = createSaveTransaction({ service, id, patch, etag });
  try {
    return await transaction.execute();
  } catch (error) {
    error.transaction = transaction;
    error.retryReadback = transaction.retryReadback;
    throw error;
  }
}

export async function saveDraftWithReadback({ service, id, draft, base, etag, maxRetries = 3, retryBaseDelay = 250, retryMaxDelay = 4000 } = {}) {
  const patch = buildMinimalPatch(draft, base);
  if (!Object.keys(patch).length) return { patch: {}, item: { ...base, __etag: etag }, skipped: true };
  try {
    const transaction = createSaveTransaction({ service, id, patch, etag, maxRetries, retryBaseDelay, retryMaxDelay });
    const item = await transaction.execute();
    return { patch, item, skipped: false };
  } catch (error) {
    error.patch = patch;
    throw error;
  }
}

export function createSaveTransaction({ service, id, patch, etag, maxRetries = 3, retryBaseDelay = 250, retryMaxDelay = 4000 } = {}) {
  if (!service || typeof service.update !== 'function') throw new TypeError('A case update service is required');
  if (typeof service.get !== 'function') throw new Error('Successful save requires a SharePoint readback service');
  if (!etag) {
    const error = new Error('SharePoint update requires the current item ETag');
    error.code = 'ETAG_REQUIRED';
    throw error;
  }
  let state = 'idle';
  let updated = null;

  function matchesPatch(readback = {}) {
    for (const [field, expectedValue] of Object.entries(patch ?? {})) {
      const dateField = ['DocDate', 'EscalationDate', 'DateResolved'].includes(field);
      const actualComparable = dateField ? dateInputValue(readback[field]) : String(readback[field] ?? '');
      const expectedComparable = dateField ? dateInputValue(expectedValue) : String(expectedValue ?? '');
      if (actualComparable !== expectedComparable) return field;
    }
    return null;
  }

  async function confirmReadback() {
    state = 'confirming';
    try {
      const readback = await retryTransientOperation(() => service.get(id), { maxRetries, retryBaseDelay, retryMaxDelay });
      const mismatchField = matchesPatch(readback);
      if (mismatchField) {
        const mismatch = new Error(`SharePoint readback did not confirm ${mismatchField}`);
        mismatch.code = 'READBACK_MISMATCH';
        mismatch.field = mismatchField;
        throw mismatch;
      }
      state = 'confirmed';
      return { ...updated, ...readback };
    } catch (error) {
      state = 'confirmation-pending';
      const pending = new Error(`Save sent but server confirmation is pending: ${error.message}`);
      pending.code = 'READBACK_UNCONFIRMED';
      pending.cause = error;
      pending.field = error.field;
      pending.transaction = api;
      pending.retryReadback = confirmReadback;
      throw pending;
    }
  }

  async function execute() {
    if (state !== 'idle') throw new Error(`Save transaction cannot execute from ${state}`);
    state = 'writing';
    // The write is deliberately outside the retry helper. Once MERGE is sent,
    // every later attempt is GET-only and can never issue a second MERGE.
    updated = await service.update(id, patch, etag);
    return confirmReadback();
  }

  const api = {
    execute,
    retryReadback: confirmReadback,
    getState: () => state,
  };
  return api;
}

export function createExplicitSaveController({ item = {}, etag = null } = {}) {
  let base = { ...item };
  let draft = { ...item };
  let currentEtag = etag ?? item.__etag ?? null;

  function change(field, value) {
    if (!field) return;
    draft = { ...draft, [field]: value };
  }

  function getPatch() {
    return buildMinimalPatch(draft, base);
  }

  function markSaved(serverItem = {}, serverEtag = null) {
    base = { ...base, ...serverItem };
    draft = { ...base };
    currentEtag = serverEtag ?? serverItem.__etag ?? currentEtag;
  }

  function discard() {
    draft = { ...base };
  }

  function refreshServer(serverItem = {}, serverEtag = null) {
    const pending = getPatch();
    const nextBase = { ...base, ...serverItem };
    Object.keys(pending).forEach((field) => { nextBase[field] = base[field]; });
    base = nextBase;
    draft = { ...base, ...pending };
    currentEtag = serverEtag ?? serverItem.__etag ?? currentEtag;
  }

  function resolveConflict({ etag: nextEtag, field, choice, serverValue } = {}) {
    if (!field || !['keep-pending', 'use-server'].includes(choice)) return false;
    if (choice === 'use-server') {
      base = { ...base, [field]: serverValue };
      draft = { ...draft, [field]: serverValue };
    } else {
      base = { ...base, [field]: serverValue };
      draft = { ...draft, [field]: draft[field] };
    }
    if (nextEtag) currentEtag = nextEtag;
    return true;
  }

  return {
    change,
    discard,
    getDraft: () => ({ ...draft }),
    getBase: () => ({ ...base }),
    getPatch,
    getEtag: () => currentEtag,
    isDirty: () => Object.keys(getPatch()).length > 0,
    markSaved,
    refreshServer,
    resolveConflict,
    setEtag: (nextEtag) => { currentEtag = nextEtag ?? currentEtag; },
  };
}

export function shouldWarnForUnsavedNavigation(editor) {
  return Boolean(editor?.isDirty?.());
}

function retryAfterMilliseconds(error) {
  if (Number.isFinite(error?.retryAfterMs)) return Math.max(0, Number(error.retryAfterMs));
  if (Number.isFinite(error?.retryAfter)) return Math.max(0, Number(error.retryAfter) * 1000);
  if (typeof error?.retryAfter === 'string') {
    const seconds = Number(error.retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const retryAt = Date.parse(error.retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }
  return null;
}

function isTransientSaveError(error) {
  if (!error || error.code === 'ETAG_CONFLICT' || error.code === 'CLOSE_READBACK_FAILED') return false;
  if (error.status === 429 || (Number(error.status) >= 500 && Number(error.status) <= 599)) return true;
  return error.code === 'NETWORK_ERROR' || error.name === 'TypeError' || error.isNetworkError === true;
}

function waitMilliseconds(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryTransientOperation(operation, { maxRetries = 3, retryBaseDelay = 250, retryMaxDelay = 4000 } = {}) {
  let retryCount = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientSaveError(error) || retryCount >= maxRetries) throw error;
      const retryAfter = retryAfterMilliseconds(error);
      const backoff = Math.min(retryMaxDelay, retryBaseDelay * (2 ** retryCount));
      retryCount += 1;
      await waitMilliseconds(retryAfter ?? backoff);
    }
  }
}
