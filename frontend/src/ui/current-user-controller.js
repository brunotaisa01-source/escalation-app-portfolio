import {
  currentUserAriaLabel, currentUserInitials, currentUserWorkflowHeading, normaliseCurrentUser,
} from '../domain/user-identity.js';

export function applyCurrentUserIdentity({ root, detail, dom, config }, value) {
  const currentUser = normaliseCurrentUser(value);
  const detailRoot = detail ?? dom?.detail;
  config.currentUser = currentUser;
  const badge = root.querySelector('.user-badge');
  if (badge) {
    const label = currentUserAriaLabel(currentUser);
    badge.textContent = currentUserInitials(currentUser);
    badge.setAttribute('aria-label', label);
    if (currentUser) badge.setAttribute('title', label);
    else badge.removeAttribute('title');
  }
  const heading = detailRoot?.querySelector('#workflow-heading');
  if (heading) heading.textContent = currentUserWorkflowHeading(currentUser);
  return currentUser;
}

export function createCurrentUserController(context) {
  return {
    async load() {
      try {
        const currentUser = await context.service.getCurrentUser();
        return applyCurrentUserIdentity(context, currentUser ?? context.config.currentUser);
      } catch {
        return applyCurrentUserIdentity(context, context.config.currentUser);
      }
    },
  };
}
