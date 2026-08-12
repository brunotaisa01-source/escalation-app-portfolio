export function calculateFilterPopoverPosition(triggerRect, menuSize, viewport = {}) {
  const margin = Number(viewport.margin ?? 8);
  const width = Number(viewport.width ?? globalThis.innerWidth ?? 1024);
  const height = Number(viewport.height ?? globalThis.innerHeight ?? 768);
  const gap = 4;
  const menuWidth = Math.min(Number(menuSize.width ?? 260), Math.max(0, width - margin * 2));
  const naturalHeight = Number(menuSize.height ?? 320);
  const left = Math.min(Math.max(margin, triggerRect.left), Math.max(margin, width - menuWidth - margin));
  const roomBelow = Math.max(0, height - triggerRect.bottom - margin - gap);
  const roomAbove = Math.max(0, triggerRect.top - margin - gap);
  const placementY = naturalHeight <= roomBelow || roomBelow >= roomAbove ? 'below' : 'above';
  const maxHeight = placementY === 'below' ? roomBelow : roomAbove;
  const renderedHeight = Math.min(naturalHeight, maxHeight);
  const preferredTop = placementY === 'below' ? triggerRect.bottom + gap : triggerRect.top - renderedHeight - gap;
  const top = Math.min(Math.max(margin, preferredTop), Math.max(margin, height - renderedHeight - margin));
  return { left, top, maxWidth: width - margin * 2, maxHeight, placementY };
}

export function positionColumnFilterMenu(toggle, menu) {
  if (!toggle || !menu) return null;
  const triggerRect = toggle.getBoundingClientRect();
  menu.style.maxHeight = '';
  const menuRect = menu.getBoundingClientRect();
  const position = calculateFilterPopoverPosition(triggerRect, {
    width: menuRect.width,
    height: Math.max(menuRect.height, Number(menu.scrollHeight) || 0),
  }, {
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
    margin: 8,
  });
  menu.style.left = `${position.left}px`;
  menu.style.top = `${position.top}px`;
  menu.style.maxWidth = `${position.maxWidth}px`;
  menu.style.maxHeight = `${position.maxHeight}px`;
  menu.dataset.placementY = position.placementY;
  return position;
}

export function refreshColumnFilterHeader({ root, tableHead, render, bind = () => {} } = {}) {
  if (!root || !tableHead || typeof render !== 'function') {
    throw new TypeError('Column filter header refresh requires root, tableHead and render');
  }
  if (root.querySelector('[data-column-filter-menu]:not([hidden])')) return false;
  tableHead.innerHTML = render();
  bind();
  return true;
}

export function closeColumnFilterMenu(toggle, menu) {
  if (!toggle || !menu) return;
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
}

export function openColumnFilterMenu(toggle, menu) {
  if (!toggle || !menu) return;
  menu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  positionColumnFilterMenu(toggle, menu);
  menu.querySelector('button, input, select')?.focus();
}
