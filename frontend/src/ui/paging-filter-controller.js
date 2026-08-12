import { HEADER_FILTER_DEFINITIONS, textValue } from './workbench-view.js';
import { closeColumnFilterMenu, openColumnFilterMenu, positionColumnFilterMenu } from './column-filter-menu.js';
import { parseCalendarDateInput } from '../domain/sharepoint-calendar-date.js';

export const PAGE_SIZES = Object.freeze([10, 20, 50]);

export function validatePageSize(value) {
  const pageSize = Number(value);
  if (!PAGE_SIZES.includes(pageSize)) throw new RangeError('Page size must be 10, 20 or 50');
  return pageSize;
}

export function createCasePaginationController({ query, initialPageSize = 10 } = {}) {
  if (typeof query !== 'function') throw new TypeError('A query function is required');
  let page = 1;
  let pageSize = validatePageSize(initialPageSize);
  let filters = { status: 'Open', query: '' };
  let result = { items: [], page, pageSize, total: null, hasNext: false };
  let latestRequestKey = null;
  const state = () => ({ ...result, page, pageSize, hasPrevious: page > 1, hasNext: Boolean(result.hasNext), filters: { ...filters }, items: result.items ?? [] });
  const applyResult = (nextResult, requestArgs) => {
    if (JSON.stringify(requestArgs) !== latestRequestKey) return state();
    const next = nextResult ?? {};
    result = {
      items: next.items ?? [], page: next.page ?? requestArgs.page,
      pageSize: next.pageSize ?? requestArgs.pageSize,
      total: next.total == null ? null : Number(next.total), totalPromise: null,
      hasNext: next.hasNext ?? (next.total != null && requestArgs.page * requestArgs.pageSize < Number(next.total)),
    };
    if (next.totalPromise) {
      result.totalPromise = Promise.resolve(next.totalPromise).then((total) => {
        if (JSON.stringify(requestArgs) !== latestRequestKey) return total;
        result.total = Number(total);
        result.hasNext = requestArgs.page * requestArgs.pageSize < result.total;
        result.totalPromise = null;
        return result.total;
      });
    }
    return state();
  };
  const request = () => {
    const requestArgs = { ...filters, page, pageSize };
    latestRequestKey = JSON.stringify(requestArgs);
    const pending = query(requestArgs);
    return pending && typeof pending.then === 'function' ? pending.then((next) => applyResult(next, requestArgs)) : applyResult(pending, requestArgs);
  };
  return {
    getState: state,
    request,
    setFilters(next = {}) { filters = { ...filters, ...next }; page = 1; return request(); },
    setPageSize(next) { pageSize = validatePageSize(next); page = 1; return request(); },
    next() { if (!state().hasNext) return state(); page += 1; return request(); },
    previous() { if (!state().hasPrevious) return state(); page -= 1; return request(); },
  };
}

export function collectColumnFilter(field, menu, { quiet = false } = {}) {
  const definition = HEADER_FILTER_DEFINITIONS[field];
  if (definition.kind === 'categorical') {
    const values = [...menu.querySelectorAll('input[type="checkbox"][data-filter-value]:checked')].map((input) => input.dataset.filterValue);
    return values.length ? { kind: 'categorical', values } : null;
  }
  const operator = menu.querySelector('[data-filter-operator]')?.value;
  const valueInput = menu.querySelector('input[data-filter-value]');
  const toInput = menu.querySelector('input[data-filter-to]');
  valueInput?.setCustomValidity?.('');
  toInput?.setCustomValidity?.('');
  const value = textValue(valueInput?.value);
  if (!value) return null;
  if (definition.kind === 'date' && !parseCalendarDateInput(value)) return undefined;
  if (operator !== 'between') return { kind: definition.kind, operator, value };
  const to = textValue(toInput?.value);
  if (!to) return quiet ? undefined : invalidRange(toInput, 'Enter the To value for Between');
  if (definition.kind === 'date' && !parseCalendarDateInput(to)) return undefined;
  const fromComparable = definition.kind === 'date' ? parseCalendarDateInput(value) : Number(value);
  const toComparable = definition.kind === 'date' ? parseCalendarDateInput(to) : Number(to);
  if (Number.isFinite(fromComparable) && Number.isFinite(toComparable) && fromComparable > toComparable) {
    return quiet ? undefined : invalidRange(toInput, 'To must be greater than or equal to Value');
  }
  return { kind: definition.kind, operator, from: value, to };
}

function invalidRange(input, message) {
  input?.setCustomValidity?.(message);
  input?.reportValidity?.();
  input?.focus?.();
  return undefined;
}

function bindFilterMenu({ root, toggle, getFilters, setFilter }) {
  const field = toggle.dataset.columnFilterToggle;
  const menu = root.querySelector(`[data-column-filter-menu="${field}"]`);
  if (!menu) return;
  toggle.addEventListener('click', () => {
    const shouldOpen = menu.hidden;
    root.querySelectorAll('[data-column-filter-menu]').forEach((candidate) => { candidate.hidden = true; });
    root.querySelectorAll('[data-column-filter-toggle]').forEach((candidate) => candidate.setAttribute('aria-expanded', 'false'));
    if (shouldOpen) openColumnFilterMenu(toggle, menu); else closeColumnFilterMenu(toggle, menu);
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeColumnFilterMenu(toggle, menu); toggle.focus(); }
  });
  menu.querySelector('[data-filter-select-all]')?.addEventListener('click', () => {
    menu.querySelectorAll('input[type="checkbox"][data-filter-value]').forEach((input) => { input.checked = true; });
  });
  menu.querySelector('[data-filter-clear]')?.addEventListener('click', () => {
    menu.querySelectorAll('input[type="checkbox"][data-filter-value]').forEach((input) => { input.checked = false; });
  });
  menu.querySelector('[data-filter-operator]')?.addEventListener('change', (event) => {
    const isBetween = event.target.value === 'between';
    const toInput = menu.querySelector('[data-filter-to]');
    const toLabel = menu.querySelector('[data-filter-to-label]');
    if (toInput) toInput.hidden = !isBetween;
    if (toLabel) toLabel.hidden = !isBetween;
    positionColumnFilterMenu(toggle, menu);
  });
  menu.querySelector('[data-filter-apply]')?.addEventListener('click', () => applyFilter({ field, menu, toggle, getFilters, setFilter }));
  menu.querySelector('[data-filter-reset]')?.addEventListener('click', () => {
    clearFilter({ field, menu, toggle, getFilters, setFilter });
  });
}

function applyFilter({ field, menu, toggle, getFilters, setFilter }) {
  const next = { ...getFilters() };
  const entry = collectColumnFilter(field, menu);
  if (entry === undefined) return;
  if (entry) next[field] = entry; else delete next[field];
  closeColumnFilterMenu(toggle, menu);
  setFilter(next);
}

function clearFilter({ field, menu, toggle, getFilters, setFilter }) {
  const next = { ...getFilters() };
  delete next[field];
  closeColumnFilterMenu(toggle, menu);
  setFilter(next);
}

export function bindColumnFilters({ root, getFilters, setFilter }) {
  root.querySelectorAll('[data-column-filter-toggle]').forEach((toggle) => bindFilterMenu({
    root, toggle, getFilters, setFilter,
  }));
}
