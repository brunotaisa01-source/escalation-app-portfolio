function snapshot(state) {
  return { ...state, item: state.item ? { ...state.item } : null };
}

export function createEditorHydrationController({ hydrate, onState = () => {} } = {}) {
  if (typeof hydrate !== 'function') throw new TypeError('Editor hydration requires a single-item GET function');
  let state = { status: 'idle', item: null, error: null };
  let selected = null;
  let sequence = 0;

  function setState(next) {
    state = next;
    onState(snapshot(state));
  }

  async function load(item) {
    selected = { ...item };
    const requestId = ++sequence;
    setState({ status: 'loading', item: selected, error: null });
    try {
      const hydrated = await hydrate(selected.id);
      if (requestId !== sequence) return null;
      if (!hydrated?.__etag) {
        const error = new Error('SharePoint did not return an ETag. Retry loading the editor.');
        error.code = 'ETAG_UNAVAILABLE';
        throw error;
      }
      const ready = { ...selected, ...hydrated };
      setState({ status: 'ready', item: ready, error: null });
      return ready;
    } catch (error) {
      if (requestId !== sequence) return null;
      setState({ status: 'error', item: selected, error });
      throw error;
    }
  }

  return {
    select: load,
    retry() {
      if (!selected) return Promise.reject(new Error('No escalation is selected for ETag retry'));
      return load(selected);
    },
    clear() {
      sequence += 1;
      selected = null;
      setState({ status: 'idle', item: null, error: null });
    },
    getState: () => snapshot(state),
  };
}
