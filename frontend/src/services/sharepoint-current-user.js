import { normaliseCurrentUser } from '../domain/user-identity.js';

let currentUserReadSequence = 0;

function currentUserUrl(baseUrl) {
  currentUserReadSequence += 1;
  const fresh = `${Date.now()}-${currentUserReadSequence}`;
  return `${baseUrl}/_api/web/currentuser?$select=Title%2CEmail%2CLoginName&_fresh=${encodeURIComponent(fresh)}`;
}

export function createCurrentUserReader({ request, baseUrl } = {}) {
  if (typeof request !== 'function') throw new TypeError('Current user reader requires authenticated SharePoint transport');
  return async () => {
    const response = await request(currentUserUrl(String(baseUrl).replace(/\/$/, '')), {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (!response.ok) throw new Error(`SharePoint current user read failed (${response.status})`);
    const identity = normaliseCurrentUser(await response.json());
    if (!identity) throw new Error('SharePoint current user identity was not returned');
    return identity;
  };
}
