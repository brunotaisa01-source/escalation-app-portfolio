import { sharePointValueMatches } from '../domain/sharepoint-calendar-date.js';

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function immutableSnapshot({ itemId, patch, etag, uiState }) {
  return deepFreeze(clone({ itemId, patch: { ...(patch ?? {}) }, sentEtag: etag, uiState: uiState ?? {} }));
}

function createBoundedQueue(limit) {
  const waiting = [];
  let active = 0;
  function pump() {
    while (active < limit && waiting.length) {
      const entry = waiting.shift();
      active += 1;
      Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(() => { active -= 1; pump(); });
    }
  }
  return (task) => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); pump(); });
}

function isTransientReadError(error) {
  const status = Number(error?.status);
  return status === 429 || (status >= 500 && status <= 599)
    || error?.code === 'NETWORK_ERROR' || error?.name === 'TypeError' || error?.isNetworkError === true;
}

function defaultWait(milliseconds) {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

function mismatchField(patch, item) {
  return Object.entries(patch).find(([field, expected]) => !sharePointValueMatches(expected, item?.[field], field))?.[0] ?? null;
}

function delayFor(attempt, baseDelayMs, maxDelayMs, jitterRatio, random) {
  const backoff = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
  const jitter = backoff * jitterRatio * ((random() * 2) - 1);
  return Math.max(0, Math.round(backoff + jitter));
}

function delayedConfirmation(transaction, lastMismatch, notify) {
  const error = new Error(lastMismatch
    ? `Confirmation delayed: authoritative readback has not confirmed ${lastMismatch}`
    : 'Confirmation delayed: authoritative readback is temporarily unavailable');
  error.code = 'CONFIRMATION_DELAYED';
  error.field = lastMismatch;
  return notify(transaction, 'Delayed', { error });
}

function createPoller(options) {
  const { service, enqueue, maxPollAttempts, wait, delay, notify, onConfirmed } = options;
  return (transaction) => enqueue(async () => {
    let lastMismatch = null;
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      if (attempt > 0) await wait(delay(attempt - 1));
      try {
        const item = await service.get(transaction.snapshot.itemId, { fresh: true });
        lastMismatch = mismatchField(transaction.snapshot.patch, item);
        if (!lastMismatch) {
          notify(transaction, 'Confirmed', { item, error: null });
          await onConfirmed(item, transaction.snapshot, transaction);
          return transaction;
        }
      } catch (error) {
        if (!isTransientReadError(error)) return notify(transaction, 'Error', { error });
        transaction.error = error;
      }
    }
    return delayedConfirmation(transaction, lastMismatch, notify);
  });
}

function createWriter(service, poll, notify) {
  return async (transaction) => {
    try {
      transaction.writeResult = await service.update(
        transaction.snapshot.itemId,
        transaction.snapshot.patch,
        transaction.snapshot.sentEtag,
      );
      transaction.patchSent = true;
      return poll(transaction);
    } catch (error) {
      const state = error?.code === 'ETAG_CONFLICT' || [409, 412].includes(Number(error?.status)) ? 'Conflict' : 'Error';
      return notify(transaction, state, { error });
    }
  };
}

export function createItemSaveCoordinator(options = {}) {
  const {
    service, maxConcurrentReadbacks = 2, maxPollAttempts = 5,
    baseDelayMs = 250, maxDelayMs = 4000, jitterRatio = 0.2,
    wait = defaultWait, random = Math.random, onState = () => {}, onConfirmed = () => {},
  } = options;
  if (typeof service?.update !== 'function' || typeof service?.get !== 'function') throw new TypeError('Save coordinator requires update and GET services');
  const transactions = new Map();
  const enqueue = createBoundedQueue(Math.max(1, Number(maxConcurrentReadbacks) || 1));

  function notify(transaction, state, extra = {}) {
    Object.assign(transaction, { state, ...extra });
    onState(transaction);
    return transaction;
  }

  const poll = createPoller({
    service, enqueue, maxPollAttempts, wait,
    delay: (attempt) => delayFor(attempt, baseDelayMs, maxDelayMs, jitterRatio, random),
    notify, onConfirmed,
  });
  const writeThenPoll = createWriter(service, poll, notify);

  function save({ itemId, patch, etag, uiState = {} } = {}) {
    if (itemId === undefined || itemId === null || !etag || !Object.keys(patch ?? {}).length) throw new TypeError('Save requires itemId, patch and ETag');
    const existing = transactions.get(String(itemId));
    if (existing && ['Pending', 'Delayed'].includes(existing.state)) {
      const error = new Error('This escalation already has a submitted save');
      error.code = 'ITEM_SAVE_LOCKED';
      throw error;
    }
    const transaction = {
      snapshot: immutableSnapshot({ itemId, patch, etag, uiState }),
      state: 'Pending', item: null, error: null, patchSent: false, writeResult: null, completion: null,
    };
    transactions.set(String(itemId), transaction);
    notify(transaction, 'Pending');
    transaction.completion = writeThenPoll(transaction);
    return transaction;
  }

  function retry(itemId) {
    const transaction = transactions.get(String(itemId));
    if (!transaction?.patchSent) return Promise.reject(new Error('No submitted PATCH is available for GET-only retry'));
    if (transaction.state === 'Pending') return transaction.completion;
    notify(transaction, 'Pending', { error: null });
    transaction.completion = poll(transaction);
    return transaction.completion;
  }

  return {
    save, retry,
    get: (itemId) => transactions.get(String(itemId)) ?? null,
    all: () => new Map(transactions),
    isLocked: (itemId) => ['Pending', 'Delayed'].includes(transactions.get(String(itemId))?.state),
  };
}
