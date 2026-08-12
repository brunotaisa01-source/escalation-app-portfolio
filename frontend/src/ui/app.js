import { createConfiguredCaseService } from '../services/case-service.js';
import { downloadEscalationCsv } from '../services/csv-export.js';
import { readRuntimeConfig } from '../config/runtime-config.example.js';
import {
  appShellMarkup, createDetailChoices, EMAIL_FIELDS, escapeHtml, OPERATOR_FIELDS,
  TABLE_RENDER_COLUMN_COUNT, renderTable, renderTableHeader, textValue,
} from './workbench-view.js';
import { positionColumnFilterMenu, refreshColumnFilterHeader } from './column-filter-menu.js';
import { bindColumnFilters, createCasePaginationController, PAGE_SIZES } from './paging-filter-controller.js';
import { createEditorWorkflow } from './editor-workflow.js';
import { createEditorHydrationController } from './editor-hydration-controller.js';
import { createVendorFinderController } from './vendor-finder-controller.js';
import { createItemSaveCoordinator } from './save-transaction-coordinator.js';
import { createKpiLoadCoordinator } from './kpi-load-coordinator.js';
import { createLiveFilterController } from './live-filter-controller.js';
import { createCurrentUserController } from './current-user-controller.js';
import { createBackgroundRefreshController } from './background-refresh-controller.js';
import { isUnknownStatus } from '../domain/status-policy.js';
import {
  bindEditableControl, buildConflictComparison, buildMinimalPatch, commitStatusTransition,
  createExplicitSaveController, createSaveTransaction, REQUIRED_SAVE_FIELDS,
  saveCasePatchWithReadback, saveDraftWithReadback, shouldWarnForUnsavedNavigation,
  validateDraftForSave,
} from './save-controller.js';

export {
  bindEditableControl, buildConflictComparison, buildMinimalPatch, commitStatusTransition,
  createCasePaginationController, createDetailChoices, createEditorWorkflow,
  createExplicitSaveController, createSaveTransaction, createVendorFinderController,
  createItemSaveCoordinator, createKpiLoadCoordinator,
  EMAIL_FIELDS, OPERATOR_FIELDS, PAGE_SIZES, REQUIRED_SAVE_FIELDS,
  saveCasePatchWithReadback, saveDraftWithReadback, shouldWarnForUnsavedNavigation,
  validateDraftForSave,
};

function uniqueValues(values) { return [...new Set(values.map(textValue).filter(Boolean))]; }

export function deriveStatusFilter(selectedStatuses = []) {
  const statuses = uniqueValues(Array.isArray(selectedStatuses) ? selectedStatuses : [selectedStatuses]);
  if (!statuses.length) return { status: 'None', statuses: [] };
  if (statuses.length === 4) return { status: 'All', statuses };
  if (statuses.length === 2 && statuses.includes('Action Required') && statuses.includes('In Progress')) return { status: 'Open', statuses };
  if (statuses.length === 2 && statuses.includes('Closed') && statuses.includes('Duplicate')) return { status: 'Closed', statuses };
  return { status: statuses[0], statuses };
}

function createContext(root, options) {
  const runtimeConfig = options.config ?? readRuntimeConfig();
  const config = { ...runtimeConfig, currentUser: runtimeConfig.currentUser ?? null };
  const service = options.service ?? createConfiguredCaseService(config, globalThis.fetch);
  const pageSize = PAGE_SIZES.includes(Number(config.pageSize)) ? Number(config.pageSize) : 10;
  root.innerHTML = appShellMarkup(config);
  const state = {
    selectedItem: null, currentItems: [], activeDraft: null, drafts: new Map(), vendorResults: [], kpis: null,
    vendorLookupState: { status: 'idle', query: '', message: '' },
    filters: { status: 'Open', statuses: [], query: '', sourceQueues: [], priorities: [], vendorMatched: undefined, columnFilters: {} },
  };
  const dom = {
    tableHead: root.querySelector('#case-table-head'), tableBody: root.querySelector('#case-table-body'),
    detail: root.querySelector('#detail-panel'), live: root.querySelector('#live-status'),
    pageSize: root.querySelector('#page-size'), previous: root.querySelector('#previous-page'),
    next: root.querySelector('#next-page'), pageStatus: root.querySelector('#page-status'),
    search: root.querySelector('#case-search'), exportButton: root.querySelector('#export-csv'),
    clearColumnFilters: root.querySelector('#clear-column-filters'),
    retryKpis: root.querySelector('#retry-kpis'),
    kpiState: root.querySelector('#kpi-state'), oldest: root.querySelector('#kpi-oldest-open'),
    userBadge: root.querySelector('.user-badge'),
  };
  dom.pageSize.value = String(pageSize);
  return {
    root, config, service, state, dom, requestSequence: 0, editor: null, hydration: null,
    kpis: null, saves: null, liveFilters: null, currentUser: null, backgroundRefresh: null,
    initialPageRendered: false, exportAbort: null,
    pagination: createCasePaginationController({ query: (request) => service.query(request), initialPageSize: pageSize }),
  };
}

function setLive(context, message) { context.dom.live.textContent = message; }

function confirmUnsavedNavigation(context) {
  if (!context.editor.hasUnsavedChanges()) return true;
  return typeof globalThis.confirm === 'function' && globalThis.confirm('You have unsaved changes. Leave this case and discard them?');
}

function setKpiValues(context, value) {
  for (const [id, count] of [['kpi-open', value.open], ['kpi-closed', value.closed], ['kpi-critical', value.critical], ['kpi-vendor-unmatched', value.vendorUnmatched]]) {
    context.root.querySelector(`#${id}`).textContent = String(count);
  }
  context.dom.oldest.disabled = !value.oldestOpen;
}

function applyKpiState(context, state) {
  if (state.status === 'loading' || state.status === 'idle') {
    context.root.querySelectorAll('[data-kpi-value]').forEach((node) => { node.textContent = 'Loading'; });
    context.dom.retryKpis.hidden = true;
    context.dom.oldest.disabled = true;
    context.dom.kpiState.textContent = 'Loading all KPI totals in one bounded SharePoint scan...';
    return;
  }
  if (state.status === 'ready') {
    context.state.kpis = state.value;
    setKpiValues(context, state.value);
    context.dom.retryKpis.hidden = true;
    context.dom.kpiState.textContent = 'KPI totals loaded.';
    return;
  }
  context.root.querySelectorAll('[data-kpi-value]').forEach((node) => { node.textContent = 'Unavailable'; });
  context.dom.retryKpis.hidden = false;
  context.dom.oldest.disabled = true;
  context.dom.kpiState.textContent = `KPI totals unavailable: ${state.error?.message ?? 'scan failed'}`;
}

export function formatPageStatus(page) {
  const totalPages = Number.isFinite(page.total) ? Math.max(1, Math.ceil(page.total / page.pageSize)) : null;
  if (!totalPages) return `Page ${page.page} · Calculating total…`;
  const current = Math.min(page.page, totalPages);
  return `Page ${current} of ${totalPages} · ${page.total} case${page.total === 1 ? '' : 's'}`;
}

function updatePageControls(context, page) {
  context.dom.previous.disabled = !page.hasPrevious;
  context.dom.next.disabled = !page.hasNext;
  context.dom.pageStatus.textContent = formatPageStatus(page);
}

function resolveExactPageTotal(context, page) {
  if (!page.totalPromise) return;
  Promise.resolve(page.totalPromise).then(() => {
    const current = context.pagination.getState();
    if (current.page !== page.page || current.pageSize !== page.pageSize || !Number.isFinite(current.total)) return;
    updatePageControls(context, current);
    setLive(context, `${current.total} case${current.total === 1 ? '' : 's'} found · showing ${current.items.length} on page ${current.page}`);
  }).catch((error) => {
    context.dom.pageStatus.textContent = 'Exact total unavailable';
    setLive(context, `Case total calculation failed: ${error.message}`);
  });
}

function syncSelectedRows(context) {
  context.dom.tableBody.querySelectorAll('.case-table-row').forEach((row) => {
    const selected = String(row.dataset.caseId) === String(context.state.selectedItem?.id);
    row.classList.toggle('is-selected', selected);
    row.setAttribute('aria-current', String(selected));
    const radio = row.querySelector('.row-selection-radio');
    if (radio) radio.checked = selected;
  });
}

async function hydrateSelection(context, item) {
  if (!item || !confirmUnsavedNavigation(context)) return;
  const selected = { ...item };
  delete selected.__etag;
  context.state.activeDraft = null;
  context.state.vendorResults = [];
  context.state.vendorLookupState = { status: 'idle', query: '', message: '' };
  syncSelectedRows(context);
  try {
    await context.hydration.select(selected);
    setLive(context, `${selected.id ? 'Selected case' : 'Case'} ready to edit`);
  } catch (error) {
    setLive(context, `Editor unavailable: ${error.message}. Retry editor load.`);
  }
}

function bindRowSelection(context) {
  const rows = [...context.dom.tableBody.querySelectorAll('.case-table-row')];
  rows.forEach((row) => {
    row.querySelectorAll('[data-transaction-action]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (button.dataset.transactionAction === 'retry') void context.saves.retry(row.dataset.caseId);
      else void hydrateSelection(context, context.state.currentItems.find((item) => String(item.id) === row.dataset.caseId));
    }));
    row.addEventListener('click', () => { void hydrateSelection(context, context.state.currentItems.find((item) => String(item.id) === row.dataset.caseId)); });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        const target = rows[Math.max(0, Math.min(rows.length - 1, rows.indexOf(row) + offset))];
        target.focus();
        void hydrateSelection(context, context.state.currentItems.find((item) => String(item.id) === target.dataset.caseId));
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        void hydrateSelection(context, context.state.currentItems.find((item) => String(item.id) === row.dataset.caseId));
      }
    });
  });
}

function renderResult(context, page) {
  context.state.currentItems = page.items ?? [];
  refreshColumnFilterHeader({
    root: context.root,
    tableHead: context.dom.tableHead,
    render: () => renderTableHeader(context.state.currentItems, context.config, context.state.filters.columnFilters),
    bind: () => bindColumnFilters({
      root: context.root,
      getFilters: () => context.state.filters.columnFilters,
      setFilter: (columnFilters) => setFilter(context, { columnFilters }),
    }),
  });
  context.dom.clearColumnFilters.disabled = !Object.keys(context.state.filters.columnFilters).length;
  context.dom.tableBody.innerHTML = renderTable(context.state.currentItems, context.state.selectedItem?.id, context.saves?.all());
  updatePageControls(context, page);
  resolveExactPageTotal(context, page);
  const message = page.total === 0 ? 'No escalations match this view.' : Number.isFinite(page.total)
    ? `${page.total} case${page.total === 1 ? '' : 's'} found · showing ${context.state.currentItems.length} on page ${page.page}`
    : `${context.state.currentItems.length} case${context.state.currentItems.length === 1 ? '' : 's'} loaded on page ${page.page}${page.hasNext ? ' · more available' : ''}`;
  const unknownCount = context.state.filters.status === 'All'
    ? context.state.currentItems.filter((item) => isUnknownStatus(item.Status)).length : 0;
  setLive(context, unknownCount ? `${message} Warning: ${unknownCount} unknown status value${unknownCount === 1 ? '' : 's'} shown in All only.` : message);
  bindRowSelection(context);
  if (!context.initialPageRendered) {
    context.initialPageRendered = true;
    void context.kpis.start().catch(() => {});
  }
}

function renderError(context, error) {
  context.dom.tableBody.innerHTML = `<tr><td class="table-empty error-state" colspan="${TABLE_RENDER_COLUMN_COUNT}" role="alert">Unable to load cases: ${escapeHtml(error.message)}</td></tr>`;
  context.dom.previous.disabled = true;
  context.dom.next.disabled = true;
  context.dom.pageStatus.textContent = 'Pagination unavailable';
  setLive(context, 'Case loading failed');
}

function refresh(context, request = () => context.pagination.request(), { background = false } = {}) {
  const requestId = ++context.requestSequence;
  if (!background) setLive(context, 'Loading cases...');
  try {
    return Promise.resolve(request()).then((page) => {
      if (requestId === context.requestSequence) renderResult(context, page);
      return page;
    }).catch((error) => {
      if (requestId === context.requestSequence && !background) renderError(context, error);
      if (background) throw error;
      return null;
    });
  } catch (error) {
    if (!background) renderError(context, error);
    return background ? Promise.reject(error) : Promise.resolve(null);
  }
}

function setFilter(context, next) {
  context.state.filters = { ...context.state.filters, ...next };
  refresh(context, () => context.pagination.setFilters(context.state.filters));
}

function bindStatusTabs(context) {
  const buttons = [...context.root.querySelectorAll('[data-status]')];
  buttons.forEach((button) => button.addEventListener('click', () => {
    const status = button.dataset.status;
    buttons.forEach((candidate) => candidate.setAttribute('aria-selected', String(candidate === button)));
    setFilter(context, { status, statuses: [] });
  }));
  buttons.forEach((button) => button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = buttons.indexOf(button);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[nextIndex].focus();
    buttons[nextIndex].click();
  }));
}

async function runExport(context) {
  if (context.exportAbort) { context.exportAbort.abort(); return; }
  const abort = new AbortController();
  context.exportAbort = abort;
  context.dom.exportButton.textContent = 'Cancel export';
  setLive(context, 'Preparing all items in the current view for CSV export...');
  try {
    const rows = await context.service.exportAll({ ...context.state.filters }, { signal: abort.signal });
    const result = downloadEscalationCsv(rows);
    setLive(context, `${rows.length} case${rows.length === 1 ? '' : 's'} from the current view exported to ${result.filename}`);
  } catch (error) {
    const cancelled = error?.code === 'TRAVERSAL_CANCELLED' || error?.name === 'AbortError';
    setLive(context, cancelled ? 'CSV export cancelled; no file was created' : `CSV export unavailable: ${error.message}`);
  } finally {
    context.exportAbort = null;
    context.dom.exportButton.textContent = 'Export items';
  }
}

function bindActions(context) {
  context.dom.exportButton.addEventListener('click', () => { void runExport(context); });
  context.dom.clearColumnFilters.addEventListener('click', () => {
    context.root.querySelectorAll('[data-column-filter-menu]').forEach((menu) => { menu.hidden = true; });
    context.liveFilters.clearAll();
    context.dom.clearColumnFilters.disabled = true;
  });
  context.dom.retryKpis.addEventListener('click', () => { void context.kpis.retry().catch(() => {}); });
  context.dom.oldest.addEventListener('click', () => {
    if (context.state.kpis?.oldestOpen) void hydrateSelection(context, context.state.kpis.oldestOpen);
  });
}

function bindShellEvents(context) {
  bindStatusTabs(context);
  context.dom.search.addEventListener('input', () => setFilter(context, { query: context.dom.search.value }));
  context.dom.pageSize.addEventListener('change', () => refresh(context, () => context.pagination.setPageSize(context.dom.pageSize.value)));
  context.dom.previous.addEventListener('click', () => refresh(context, () => context.pagination.previous()));
  context.dom.next.addEventListener('click', () => refresh(context, () => context.pagination.next()));
  bindActions(context);
  if (typeof globalThis.addEventListener !== 'function') return;
  globalThis.addEventListener('beforeunload', (event) => {
    context.backgroundRefresh?.stop();
    if (!context.editor.hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  globalThis.addEventListener('resize', () => {
    const toggle = context.root.querySelector('[data-column-filter-toggle][aria-expanded="true"]');
    const menu = toggle ? context.root.querySelector(`[data-column-filter-menu="${toggle.dataset.columnFilterToggle}"]`) : null;
    if (toggle && menu && !menu.hidden) positionColumnFilterMenu(toggle, menu);
  });
}

function editorOwnsFocus(context) {
  const active = context.root.ownerDocument?.activeElement ?? globalThis.document?.activeElement;
  return Boolean(active && context.dom.detail.contains(active));
}

async function syncCleanSelectedItem(context) {
  const selectedId = context.state.selectedItem?.id;
  if (!selectedId || context.editor.hasUnsavedChanges() || editorOwnsFocus(context)) return false;
  const item = await context.service.hydrateForEdit(selectedId);
  if (String(context.state.selectedItem?.id) !== String(selectedId)
      || context.editor.hasUnsavedChanges() || editorOwnsFocus(context)) return false;
  const draft = context.state.drafts.get(String(selectedId));
  draft?.controller.markSaved(item, item.__etag);
  context.state.selectedItem = { ...item, __editHydrationStatus: 'ready', __editHydrationMessage: '' };
  context.state.activeDraft = draft ?? null;
  context.editor.render();
  syncSelectedRows(context);
  return true;
}

function configureBackgroundRefresh(context) {
  context.backgroundRefresh = createBackgroundRefreshController({
    intervalMs: context.config.backgroundRefreshMs,
    invalidate: (options) => context.service.invalidateReadCaches?.(options),
    refresh: async ({ includeTotals }) => {
      await refresh(context, () => context.pagination.request(), { background: true });
      if (includeTotals) await context.kpis.refreshAfterSave();
    },
    syncSelected: () => syncCleanSelectedItem(context),
    onError: () => setLive(context, 'Background sync delayed; the app will retry automatically.'),
  });
}

function configureEditorHydration(context) {
  context.hydration = createEditorHydrationController({
    hydrate: (id) => context.service.hydrateForEdit(id),
    onState: (hydration) => {
      if (!hydration.item) return;
      context.state.selectedItem = {
        ...hydration.item,
        __editHydrationStatus: hydration.status,
        __editHydrationMessage: hydration.error?.message ?? '',
      };
      context.editor?.render();
      syncSelectedRows(context);
    },
  });
}

function renderTransactionRows(context) {
  context.dom.tableBody.innerHTML = renderTable(context.state.currentItems, context.state.selectedItem?.id, context.saves.all());
  bindRowSelection(context);
}

function configureCoordinators(context) {
  const kpiKey = [context.config.mode, context.config.siteUrl, context.config.listTitle].join('|');
  context.kpis = createKpiLoadCoordinator({
    key: kpiKey,
    load: (options) => context.service.loadKpis(options),
    onState: (state) => applyKpiState(context, state),
  });
  context.liveFilters = createLiveFilterController({
    delayMs: 400,
    initial: context.state.filters.columnFilters,
    apply: (columnFilters) => setFilter(context, { columnFilters }),
  });
  context.saves = createItemSaveCoordinator({
    service: context.service,
    onState: (transaction) => {
      renderTransactionRows(context);
      if (String(context.state.selectedItem?.id) === String(transaction.snapshot.itemId)) context.editor?.render();
    },
    onConfirmed: (item, snapshot) => {
      const draft = context.state.drafts.get(String(snapshot.itemId));
      draft?.controller.markSaved(item, item.__etag);
      if (String(context.state.selectedItem?.id) === String(snapshot.itemId)) {
        context.state.selectedItem = { ...context.state.selectedItem, ...item, __editHydrationStatus: 'ready' };
        context.state.activeDraft = draft ?? null;
        context.editor?.render();
      }
      refresh(context);
      void context.kpis.refreshAfterSave().catch(() => {});
    },
  });
}

export function renderApp(root, options = {}) {
  const context = createContext(root, options);
  configureCoordinators(context);
  context.editor = createEditorWorkflow({
    detail: context.dom.detail, service: context.service, config: context.config, state: context.state,
    saveCoordinator: context.saves,
    setLive: (message) => setLive(context, message),
    retryHydration: () => context.hydration.retry(),
  });
  configureEditorHydration(context);
  context.currentUser = createCurrentUserController(context);
  configureBackgroundRefresh(context);
  bindShellEvents(context);
  refresh(context);
  void context.currentUser.load();
  context.backgroundRefresh.start();
}

export { EMAIL_FIELDS as _EMAIL_FIELDS, OPERATOR_FIELDS as _OPERATOR_FIELDS, PAGE_SIZES as _PAGE_SIZES };
