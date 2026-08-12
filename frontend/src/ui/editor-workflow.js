import { GOVERNED_VALUES } from '../config/runtime-config.example.js';
import { FIELD_LABELS, dateInputValue, displayValue, escapeHtml, renderCaseDetail } from './workbench-view.js';
import { createVendorFinderController } from './vendor-finder-controller.js';
import {
  bindEditableControl,
  buildConflictComparison,
  createExplicitSaveController,
  missingRequiredFields,
  planStatusTransition,
  saveDraftWithReadback,
  shouldWarnForUnsavedNavigation,
  validateDraftForSave,
} from './save-controller.js';

function editorReady(item) {
  return item?.__editHydrationStatus === 'ready' && Boolean(item.__etag);
}

function ensureDraft(state) {
  if (!editorReady(state.selectedItem)) throw new Error('Editor is not hydrated with a current SharePoint ETag');
  const key = String(state.selectedItem.id);
  if (!state.drafts?.has(key)) {
    const entry = {
      id: state.selectedItem.id,
      controller: createExplicitSaveController({ item: state.selectedItem, etag: state.selectedItem.__etag }),
    };
    state.drafts?.set(key, entry);
  }
  state.activeDraft = state.drafts?.get(key) ?? state.activeDraft;
  return state.activeDraft.controller;
}

function setControlsDisabled(detail, disabled) {
  detail.querySelectorAll('[data-field], #vendor-search, #vendor-search-button, #keep-unmatched-vendor, #clear-vendor, [data-vendor-id]')
    .forEach((control) => { control.disabled = Boolean(disabled); });
}

function updateToolbar(session) {
  const dirty = session.draft.isDirty();
  const locked = ['Pending', 'Delayed'].includes(session.transaction?.state);
  const incomplete = missingRequiredFields(session.draft.getDraft()).length > 0;
  if (session.saveButton) session.saveButton.disabled = locked || !dirty || incomplete || session.conflictNeedsRefresh || !session.draft.getEtag();
  if (session.discardButton) session.discardButton.disabled = locked || !dirty;
}

function clearValidation(session) {
  if (session.validationSummary) {
    session.validationSummary.hidden = true;
    session.validationSummary.textContent = '';
  }
  session.detail.querySelectorAll('[data-field][aria-invalid="true"]').forEach((control) => control.removeAttribute('aria-invalid'));
  session.detail.querySelectorAll('.field-error').forEach((error) => { error.hidden = true; error.textContent = ''; });
}

function showValidation(session, { focus = false } = {}) {
  clearValidation(session);
  const missing = missingRequiredFields(session.draft.getDraft());
  if (!missing.length) return true;
  const labels = missing.map((field) => FIELD_LABELS[field] ?? field);
  const message = `Complete required fields before saving: ${labels.join(', ')}`;
  session.validationSummary.hidden = false;
  session.validationSummary.textContent = message;
  missing.forEach((field) => {
    const control = [...session.detail.querySelectorAll('[data-field]')].find((candidate) => candidate.dataset.field === field);
    control?.setAttribute('aria-invalid', 'true');
    const error = session.detail.querySelector(`#field-${field}-error`);
    if (error) { error.hidden = false; error.textContent = `${FIELD_LABELS[field] ?? field} is required.`; }
  });
  if (focus) {
    session.validationSummary.focus();
    [...session.detail.querySelectorAll('[data-field]')].find((control) => control.dataset.field === missing[0])?.focus();
  }
  return false;
}

function applyConfirmedSave(context, session, item, patch) {
  context.state.selectedItem = { ...context.state.selectedItem, ...item, __editHydrationStatus: 'ready' };
  session.draft.markSaved(item, item?.__etag);
  session.conflictNeedsRefresh = false;
  session.savePending = false;
  session.pendingReadback = null;
  session.pendingReadbackPatch = null;
  if (session.retryReadback) session.retryReadback.hidden = true;
  if (session.conflictActions) session.conflictActions.hidden = true;
  if (session.conflictCompare) session.conflictCompare.hidden = true;
  setControlsDisabled(context.detail, false);
  const message = patch.Status === 'Closed' ? 'Closed confirmed by SharePoint readback' : 'Changes saved after SharePoint readback';
  session.saveState.textContent = message;
  context.setLive(message);
  updateToolbar(session);
  context.onSaved?.(item);
}

function renderConflictComparison(context, session) {
  const pending = session.draft.getPatch();
  if (!Object.keys(pending).length) {
    session.conflictCompare.hidden = false;
    session.conflictCompare.innerHTML = '<p class="field-hint">No pending local changes remain.</p>';
    updateToolbar(session);
    return;
  }
  const comparisons = buildConflictComparison(pending, session.conflictServer ?? {}, session.draft.getBase());
  session.conflictCompare.hidden = false;
  session.conflictCompare.innerHTML = comparisons.map((comparison) => `<div class="conflict-row" data-conflict-field="${escapeHtml(comparison.field)}"><strong>${escapeHtml(FIELD_LABELS[comparison.field] ?? comparison.field)}</strong><span>Server: ${displayValue(comparison.serverValue)}</span><span>Pending: ${displayValue(comparison.pendingValue)}</span><div class="conflict-choice"><button type="button" class="secondary-button" data-conflict-choice="keep-pending" data-conflict-field="${escapeHtml(comparison.field)}">Keep pending</button><button type="button" class="secondary-button" data-conflict-choice="use-server" data-conflict-field="${escapeHtml(comparison.field)}">Use server</button></div></div>`).join('');
  session.conflictNeedsRefresh = comparisons.some((comparison) => comparison.sameFieldChanged);
  session.conflictCompare.querySelectorAll('[data-conflict-choice]').forEach((button) => button.addEventListener('click', () => resolveConflictChoice(context, session, button)));
  updateToolbar(session);
}

function resolveConflictChoice(context, session, button) {
  const field = button.dataset.conflictField;
  const choice = button.dataset.conflictChoice;
  const serverValue = session.conflictServer?.[field] ?? '';
  session.draft.resolveConflict({ etag: session.conflictEtag, field, choice, serverValue });
  if (choice === 'use-server') {
    context.state.selectedItem[field] = serverValue;
    const control = [...context.detail.querySelectorAll('[data-field]')].find((candidate) => candidate.dataset.field === field);
    if (control) control.value = serverValue;
  }
  renderConflictComparison(context, session);
  session.saveState.textContent = choice === 'keep-pending' ? 'Pending edit retained; choose Save when ready' : 'Server value selected; pending edit removed';
}

function bindConflictRefresh(context, session) {
  session.refreshCompare?.addEventListener('click', async () => {
    const pending = session.draft.getPatch();
    session.saveState.textContent = 'Refreshing current server state...';
    try {
      const latest = await context.service.get(context.state.selectedItem.id);
      session.conflictServer = latest ?? {};
      session.conflictEtag = latest?.__etag ?? null;
      const conflicts = buildConflictComparison(pending, session.conflictServer, session.draft.getBase()).filter((item) => item.sameFieldChanged);
      session.draft.refreshServer(latest, session.conflictEtag);
      context.state.selectedItem = { ...context.state.selectedItem, ...latest, ...session.draft.getPatch() };
      session.conflictNeedsRefresh = conflicts.length > 0;
      renderConflictComparison(context, session);
      session.saveState.textContent = conflicts.length ? 'Compare complete; choose how to resolve each changed field' : 'Safe rebase ready; choose Save to submit pending changes';
      context.setLive(conflicts.length ? 'Server changed a pending field; choose Keep pending or Use server' : 'Server refreshed; pending edits preserved and safely rebased');
    } catch (error) {
      session.saveState.textContent = `Refresh failed: ${error.message}`;
      context.setLive('Conflict refresh failed; pending edits remain local');
    }
  });
}

function handleSaveError(context, session, error, patch) {
  if (error?.code === 'READBACK_UNCONFIRMED') {
    session.pendingReadback = error.retryReadback;
    session.pendingReadbackPatch = error.patch ?? patch;
    session.saveState.textContent = 'Confirmation pending: write sent; Retry readback to confirm';
    if (session.retryReadback) session.retryReadback.hidden = false;
    setControlsDisabled(context.detail, true);
    context.setLive('Save sent; waiting for SharePoint readback. No second MERGE will be sent.');
  } else if (error?.code === 'ETAG_CONFLICT') {
    session.savePending = false;
    setControlsDisabled(context.detail, false);
    session.conflictNeedsRefresh = true;
    if (session.conflictActions) session.conflictActions.hidden = false;
    session.saveState.textContent = 'Conflict: Refresh / Compare before saving again';
    context.setLive('Conflict detected; pending edits were retained with no overwrite');
  } else {
    session.savePending = false;
    setControlsDisabled(context.detail, false);
    session.saveState.textContent = `Save failed: ${error.message}`;
    context.setLive('Save failed; pending edits remain available');
  }
  updateToolbar(session);
}

function bindSaveButton(context, session) {
  session.saveButton?.addEventListener('click', async () => {
    if (!session.draft.getEtag()) {
      session.saveState.textContent = 'Save blocked: reload the current SharePoint version first';
      return;
    }
    const candidate = session.draft.getDraft();
    let validationMessage = '';
    if (!validateDraftForSave({ draft: candidate, onInvalid: (message) => { validationMessage = message; } })) {
      showValidation(session, { focus: true });
      session.saveState.textContent = validationMessage;
      context.setLive(`Save blocked: ${validationMessage}`);
      return;
    }
    clearValidation(session);
    const patch = session.draft.getPatch();
    if (!Object.keys(patch).length) { session.saveState.textContent = 'No changes to save'; return; }
    if (context.saveCoordinator) {
      const item = context.state.selectedItem;
      try {
        context.saveCoordinator.save({
          itemId: item.id,
          patch,
          etag: session.draft.getEtag(),
          uiState: {
            selectedId: item.id,
            draft: session.draft.getDraft(),
            focus: context.detail.ownerDocument?.activeElement?.id ?? '',
            etag: session.draft.getEtag(),
          },
        });
        context.setLive('Save submitted; SharePoint confirmation is automatic');
      } catch (error) {
        session.saveState.textContent = `Save blocked: ${error.message}`;
      }
      return;
    }
    session.savePending = true;
    session.pendingReadbackPatch = patch;
    setControlsDisabled(context.detail, true);
    updateToolbar(session);
    session.saveState.textContent = 'Saving...';
    context.setLive('Saving changes to SharePoint');
    try {
      const item = context.state.selectedItem;
      const result = await saveDraftWithReadback({ service: context.service, id: item.id, draft: candidate, base: session.draft.getBase(), etag: session.draft.getEtag() });
      applyConfirmedSave(context, session, result.item, patch);
    } catch (error) { handleSaveError(context, session, error, patch); }
  });
}

function bindReadbackAndDiscard(context, session) {
  session.retryReadback?.addEventListener('click', async () => {
    if (context.saveCoordinator && session.transaction?.state === 'Delayed') {
      session.retryReadback.disabled = true;
      await context.saveCoordinator.retry(context.state.selectedItem.id);
      return;
    }
    if (typeof session.pendingReadback !== 'function') return;
    session.retryReadback.disabled = true;
    session.saveState.textContent = 'Retrying readback (GET only)...';
    try {
      const item = await session.pendingReadback();
      applyConfirmedSave(context, session, item, session.pendingReadbackPatch ?? session.draft.getPatch());
    } catch (error) {
      session.retryReadback.disabled = false;
      session.pendingReadback = error.retryReadback ?? session.pendingReadback;
      session.saveState.textContent = `Confirmation pending: ${error.message}`;
      context.setLive('Readback still pending; retry readback remains available');
    }
  });
  session.discardButton?.addEventListener('click', () => {
    if (!session.draft.isDirty()) return;
    session.draft.discard();
    context.state.selectedItem = { ...context.state.selectedItem, ...session.draft.getDraft() };
    context.state.activeDraft = null;
    context.render();
    context.setLive('Unsaved changes discarded');
  });
}

function bindEditableFields(context, session) {
  context.detail.querySelectorAll('[data-field]').forEach((control) => bindEditableControl(control, {
    getItem: () => context.state.selectedItem,
    setItem: (next) => { context.state.selectedItem = next; },
    draft: session.draft,
    governedValues: context.config.governedValues ?? GOVERNED_VALUES,
    onInvalid: (message) => { session.saveState.textContent = message; context.setLive(message); },
    onStatusTransition: ({ item, value, control }) => stageStatusTransition(context, session, item, value, control),
    onChange: () => {
      if (session.savePending) return;
      session.conflictNeedsRefresh = false;
      updateToolbar(session);
      showValidation(session);
      if (session.saveState.textContent === 'No changes') session.saveState.textContent = 'Unsaved changes';
    },
  }));
}

function setOrdinaryRequired(detail, required) {
  for (const field of ['ActionType', 'Priority', 'WorkingNotes', 'DateResolved', 'APOwner', 'Entity']) {
    const control = [...detail.querySelectorAll('[data-field]')].find((candidate) => candidate.dataset.field === field);
    if (!control) continue;
    control.required = required;
    if (required) control.setAttribute('aria-required', 'true');
    else control.removeAttribute('aria-required');
  }
}

function syncTransitionDraft(context, session, previous, next) {
  for (const [field, value] of Object.entries(next)) {
    if (String(previous[field] ?? '') === String(value ?? '')) continue;
    session.draft.change(field, value);
    context.state.selectedItem[field] = value;
    const control = [...context.detail.querySelectorAll('[data-field]')].find((candidate) => candidate.dataset.field === field);
    if (control) control.value = field === 'DateResolved' ? dateInputValue(value) : value ?? '';
  }
}

function stageStatusTransition(context, session, item, value, control) {
  const current = session.draft.getDraft();
  const result = planStatusTransition({
    base: session.draft.getBase(), draft: current, nextStatus: value,
    duplicateSnapshot: session.duplicateSnapshot,
    confirm: (message) => typeof globalThis.confirm === 'function' && globalThis.confirm(message),
  });
  if (!result.accepted) {
    control.value = current.Status ?? '';
    context.setLive('Status change cancelled; no changes were staged or written');
    return;
  }
  session.duplicateSnapshot = result.duplicateSnapshot;
  syncTransitionDraft(context, session, current, result.draft);
  setOrdinaryRequired(context.detail, result.draft.Status !== 'Duplicate');
  session.conflictNeedsRefresh = false;
  updateToolbar(session);
  showValidation(session);
  session.saveState.textContent = result.draft.Status === 'Duplicate'
    ? 'Duplicate staged; choose Save to write the confirmed fields'
    : 'Status change staged; choose Save to write';
  context.setLive(session.saveState.textContent);
  item.Status = result.draft.Status;
}

function stageVendorPatch(context, patch) {
  const session = context.currentSession;
  if (!session) throw new Error('Vendor staging requires a ready editor');
  Object.entries(patch).forEach(([field, value]) => {
    context.state.selectedItem[field] = value;
    session.draft.change(field, value);
  });
  context.state.vendorResults = [];
  updateToolbar(session);
}

function ensureVendorFinder(context) {
  const id = context.state.selectedItem?.id;
  if (!context.vendorFinder || String(context.vendorFinderId) !== String(id)) {
    context.vendorFinderId = id;
    context.vendorFinder = createVendorFinderController({
      search: (query) => context.service.searchVendorReference(query),
      onStage: (patch) => stageVendorPatch(context, patch),
    });
  }
  return context.vendorFinder;
}

function syncVendorState(context, finder) {
  const next = finder.getState();
  context.state.vendorResults = next.results;
  context.state.vendorLookupState = { status: next.status, query: next.query, message: next.message };
}

function stageAndRender(context, finder, action, message) {
  try {
    action();
    syncVendorState(context, finder);
    context.setLive(message);
    context.render();
  } catch (error) {
    context.setLive(`Vendor action unavailable: ${error.message}`);
  }
}

function bindVendorActions(context) {
  const finder = ensureVendorFinder(context);
  context.detail.querySelector('#vendor-search-button')?.addEventListener('click', async () => {
    const value = context.detail.querySelector('#vendor-search')?.value ?? '';
    const pending = finder.search(value);
    syncVendorState(context, finder);
    context.render();
    context.setLive('Searching Supplier Reference...');
    try {
      const results = await pending;
      syncVendorState(context, finder);
      context.render();
      context.setLive(results.length ? `${results.length} vendor result${results.length === 1 ? '' : 's'} found` : 'No vendor match found');
    } catch (error) {
      syncVendorState(context, finder);
      context.render();
      context.setLive(`Vendor Finder unavailable: ${error.message}`);
    }
  });
  context.detail.querySelectorAll('[data-vendor-id]').forEach((button) => button.addEventListener('click', () => stageAndRender(
    context,
    finder,
    () => finder.select({ Vendor: button.dataset.vendor, VendorName: button.dataset.vendorName, VendorCategory: button.dataset.vendorCategory }),
    'Vendor selected; review the draft and choose Save',
  )));
  context.detail.querySelector('#keep-unmatched-vendor')?.addEventListener('click', () => stageAndRender(context, finder, () => finder.keepAsUnmatched(), 'Unmatched vendor staged; review the draft and choose Save'));
  context.detail.querySelector('#clear-vendor')?.addEventListener('click', () => stageAndRender(context, finder, () => finder.clearNotApplicable(), 'Vendor cleared as not applicable; choose Save to persist'));
}

function createSession(detail, draft, transaction) {
  return {
    detail,
    draft, saveState: detail.querySelector('#save-state'), saveButton: detail.querySelector('#save-case'),
    validationSummary: detail.querySelector('#save-validation-summary'),
    discardButton: detail.querySelector('#discard-changes'), conflictActions: detail.querySelector('#conflict-actions'),
    conflictCompare: detail.querySelector('#conflict-compare'), refreshCompare: detail.querySelector('#refresh-compare'),
    retryReadback: detail.querySelector('#retry-readback'), conflictServer: null, conflictEtag: null,
    conflictNeedsRefresh: false, savePending: false, pendingReadback: null, pendingReadbackPatch: null,
    transaction, duplicateSnapshot: null,
  };
}

function applyTransactionState(context, session) {
  const transaction = session.transaction;
  if (!transaction) return;
  const locked = ['Pending', 'Delayed'].includes(transaction.state);
  setControlsDisabled(context.detail, locked);
  const messages = {
    Pending: 'Save pending: confirming the authoritative SharePoint readback…',
    Confirmed: 'Save confirmed by SharePoint readback',
    Delayed: 'Confirmation delayed. Retry performs GET only; the PATCH will not be resent.',
    Conflict: 'Conflict: refresh and compare before creating a new save transaction.',
    Error: `Save error: ${transaction.error?.message ?? 'unknown error'}`,
  };
  session.saveState.textContent = messages[transaction.state] ?? transaction.state;
  if (session.retryReadback) session.retryReadback.hidden = transaction.state !== 'Delayed';
  if (session.conflictActions) session.conflictActions.hidden = transaction.state !== 'Conflict';
  session.conflictNeedsRefresh = transaction.state === 'Conflict';
}

function renderUnavailableEditor(context) {
  const { detail, state } = context;
  detail.innerHTML = renderCaseDetail(state.selectedItem, state.currentItems, context.config, [], { status: 'idle', message: '' });
  setControlsDisabled(detail, true);
  detail.querySelector('#retry-etag')?.addEventListener('click', () => {
    context.setLive('Retrying current SharePoint version...');
    Promise.resolve(context.retryHydration()).catch((error) => context.setLive(`Editor retry failed: ${error.message}`));
  });
}

export function createEditorWorkflow({ detail, service, config, state, setLive, onSaved, retryHydration, saveCoordinator } = {}) {
  const context = { detail, service, config, state, setLive, onSaved, retryHydration, saveCoordinator, render: null, currentSession: null, vendorFinder: null, vendorFinderId: null };
  context.render = () => {
    if (!state.selectedItem) { detail.innerHTML = '<p class="empty-state">Select an escalation to inspect details.</p>'; return; }
    if (!editorReady(state.selectedItem)) { context.currentSession = null; renderUnavailableEditor(context); return; }
    const draft = ensureDraft(state);
    state.selectedItem = { ...state.selectedItem, ...draft.getDraft() };
    detail.innerHTML = renderCaseDetail(state.selectedItem, state.currentItems, config, state.vendorResults, state.vendorLookupState);
    const transaction = saveCoordinator?.get(state.selectedItem.id);
    const session = createSession(detail, draft, transaction);
    context.currentSession = session;
    if (session.conflictActions) session.conflictActions.hidden = true;
    bindEditableFields(context, session);
    bindConflictRefresh(context, session);
    bindSaveButton(context, session);
    bindReadbackAndDiscard(context, session);
    bindVendorActions(context);
    applyTransactionState(context, session);
    updateToolbar(session);
  };
  return {
    render: context.render,
    hasUnsavedChanges: () => shouldWarnForUnsavedNavigation(state.activeDraft?.controller)
      && !saveCoordinator?.isLocked(state.activeDraft?.id),
  };
}
