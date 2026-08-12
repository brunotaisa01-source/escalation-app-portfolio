import {
  buildConfirmedVendorPatch,
  buildNotApplicableVendorPatch,
  buildUnmatchedVendorPatch,
  normaliseVendorNumber,
} from '../domain/vendor-match.js';

export function createVendorFinderController({ search, onStage = () => {} } = {}) {
  if (typeof search !== 'function') throw new TypeError('Vendor search function is required');
  let state = { status: 'idle', query: '', results: [], message: '' };

  function getState() {
    return { ...state, results: [...state.results] };
  }

  async function runSearch(value) {
    const query = normaliseVendorNumber(value);
    if (!query) {
      state = { status: 'idle', query: '', results: [], message: 'Enter a vendor number, name or lookup key.' };
      return [];
    }
    state = { status: 'pending', query, results: [], message: '' };
    try {
      const results = await search(query);
      state = { status: results.length ? 'success' : 'not-found', query, results: [...results], message: '' };
      return [...results];
    } catch (error) {
      state = { status: 'error', query, results: [], message: error.message };
      throw error;
    }
  }

  function stage(patch) {
    onStage(patch);
    return patch;
  }

  return {
    getState,
    search: runSearch,
    keepAsUnmatched() {
      if (state.status !== 'not-found') throw new Error('A successful no-match search is required first');
      const patch = buildUnmatchedVendorPatch(state.query);
      state = { status: 'unmatched', query: patch.Vendor, results: [], message: 'Vendor not matched; the number will be saved without mapped name/category.' };
      return stage(patch);
    },
    clearNotApplicable() {
      state = { status: 'idle', query: '', results: [], message: '' };
      return stage(buildNotApplicableVendorPatch());
    },
    select(vendor) {
      const patch = buildConfirmedVendorPatch(vendor);
      state = { status: 'confirmed', query: patch.Vendor, results: [], message: 'Confirmed vendor values are staged in the draft; choose Save to persist.' };
      return stage(patch);
    },
  };
}
