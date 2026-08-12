export const GOVERNED_STATUSES = Object.freeze(['Action Required', 'In Progress', 'Closed', 'Duplicate']);
export const OPEN_STATUS_VALUES = Object.freeze(['Action Required', 'In Progress']);
export const CLOSED_STATUS_VALUES = Object.freeze(['Closed', 'Duplicate']);
export const CLOSED_STATUS = 'Closed';

const governedStatuses = new Set(GOVERNED_STATUSES);
const openStatuses = new Set(OPEN_STATUS_VALUES);
const closedStatuses = new Set(CLOSED_STATUS_VALUES);

export function isGovernedStatus(status) {
  return governedStatuses.has(status);
}

export function isClosedStatus(status) {
  return closedStatuses.has(status);
}

export function isOpenStatus(status) {
  return openStatuses.has(status);
}

export function isUnknownStatus(status) {
  return !isGovernedStatus(status);
}

export function matchesStatusView(status, view = 'All') {
  if (!view || view === 'All') return true;
  if (view === 'None') return false;
  if (view === 'Open') return isOpenStatus(status);
  if (view === 'Closed') return isClosedStatus(status);
  return status === view;
}
