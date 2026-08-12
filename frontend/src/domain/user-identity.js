function clean(value) { return String(value ?? '').trim(); }

function emailName(email) {
  return clean(email).split('@')[0].split(/[._-]+/).filter(Boolean).join(' ');
}

export function normaliseCurrentUser(value) {
  const source = value?.d ?? value ?? {};
  const email = clean(source.email ?? source.Email);
  const loginName = clean(source.loginName ?? source.LoginName);
  const displayName = clean(source.displayName ?? source.Title) || emailName(email);
  if (!displayName && !email && !loginName) return null;
  return { displayName, email, loginName };
}

export function currentUserInitials(value) {
  const user = normaliseCurrentUser(value);
  if (!user) return '--';
  const parts = user.displayName.split(/\s+/).filter(Boolean);
  if (!parts.length) return '--';
  const first = Array.from(parts[0])[0] ?? '';
  const last = Array.from(parts.at(-1))[0] ?? '';
  return `${first}${parts.length > 1 ? last : ''}`.toLocaleUpperCase('en-GB') || '--';
}

export function currentUserAriaLabel(value) {
  const user = normaliseCurrentUser(value);
  if (!user) return 'Current user unavailable';
  const email = user.email && user.email !== user.displayName ? ` (${user.email})` : '';
  return `Current user: ${user.displayName}${email}`;
}

export function currentUserWorkflowHeading(value) {
  const user = normaliseCurrentUser(value);
  if (!user?.displayName) return 'Workflow';
  const firstName = user.displayName.split(/\s+/)[0];
  return `${firstName}${firstName.toLocaleLowerCase('en-GB').endsWith('s') ? "'" : "'s"} workflow`;
}
