import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaseService } from '../../frontend/src/services/case-service.js';
import {
  buildEscalationQuery,
  createSharePointClient,
  DEFAULT_FIELD_MAPPING,
} from '../../frontend/src/services/sharepoint-client.js';
import { createConfiguredCaseService } from '../../frontend/src/services/case-service.js';
import { createCasePaginationController } from '../../frontend/src/ui/app.js';
import { createItemSaveCoordinator } from '../../frontend/src/ui/save-transaction-coordinator.js';
import { renderCaseDetail, renderTable } from '../../frontend/src/ui/workbench-view.js';

const LIVE_FIELD_MAPPING = Object.freeze({
  id: 'Id',
  Title: 'Title',
  UniqueKey: 'UniqueKey',
  Status: 'Status',
  Priority: 'Priority',
  Vendor: 'Vendor',
  VendorName: 'Vendor_x0020_Name',
  Reference: 'Reference',
  From: 'From',
  ReceivedDateTime: 'Received_x0020_Date_x0020_Time',
  DateResolved: 'Date_x0020_Resolved',
  WorkingNotes: 'Working_x0020_Notes',
  Mailbox: 'Mailbox',
  SourceQueue: 'Source_x0020_Queue',
  InternetMessageId: 'Internet_x0020_Message_x0020_ID',
  OutlookMessageId: 'Outlook_x0020_Message_x0020_ID',
  ConversationId: 'Conversation_x0020_ID',
  SMarker: 'SMarker',
  OriginalUniqueKey: 'Original_x0020_UniqueKey',
  VendorCategory: 'Vendor_x0020_Category',
  Entity: 'Entity',
  DocDate: 'Doc_x0020_Date',
  InvRef: 'Inv_x0020_Ref',
  Value: 'Value',
  ActionType: 'Action_x0020_Type',
  APOwner: 'AP_x0020_Owner',
  EscalationDate: 'Escalation_x0020_Date',
  DaysToResolve: 'Days_x0020_To_x0020_Resolve',
  IsClosed: 'Is_x0020_Closed',
});

const FLOW_PRODUCER_UI_VALUES = Object.freeze({
  Title: 'Sanitized subject',
  UniqueKey: 'sanitized-key',
  Mailbox: 'sanitized-mailbox',
  SourceQueue: 'Fixture-North',
  From: 'sender@example.invalid',
  Reference: 'sanitized-reference',
  ReceivedDateTime: '2026-07-31T07:30:00Z',
  InternetMessageId: 'sanitized-internet-id',
  OutlookMessageId: 'sanitized-outlook-id',
  ConversationId: 'sanitized-conversation-id',
  SMarker: '.',
  Status: 'Action Required',
});

const FLOW_PRODUCED_DEMO_ROW = Object.freeze({
  Id: 31,
  ...Object.fromEntries(
    Object.entries(FLOW_PRODUCER_UI_VALUES)
      .map(([field, value]) => [LIVE_FIELD_MAPPING[field], value]),
  ),
});

const liveConfig = (overrides = {}) => ({
  mode: 'sharepoint',
  status: 'VERIFIED',
  verified: true,
  siteUrl: 'https://fixture.example.invalid/sites/DEMO',
  listTitle: 'Escalations',
  fieldMapping: LIVE_FIELD_MAPPING,
  ...overrides,
});

test('default SharePoint mapping uses the confirmed live EntityPropertyName values', () => {
  assert.deepEqual(DEFAULT_FIELD_MAPPING, LIVE_FIELD_MAPPING);
  assert.equal(DEFAULT_FIELD_MAPPING.SourceQueue, 'Source_x0020_Queue');
  assert.notEqual(DEFAULT_FIELD_MAPPING.WorkingNotes, 'WorkingNotes');
});

test('SharePoint service resolves the authenticated current user with one cache-busted GET', async () => {
  const calls = [];
  const service = createConfiguredCaseService(liveConfig(), async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ Title: 'Avery Example', Email: 'avery.user@example.invalid', LoginName: 'member|avery.user@example.invalid' }),
    };
  });

  assert.equal(typeof service.getCurrentUser, 'function');
  assert.deepEqual(await service.getCurrentUser(), {
    displayName: 'Avery Example',
    email: 'avery.user@example.invalid',
    loginName: 'member|avery.user@example.invalid',
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/_api\/web\/currentuser\?\$select=Title%2CEmail%2CLoginName&_fresh=/);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.cache, 'no-store');
});

test('SharePoint service exposes read-cache invalidation without issuing a write', () => {
  const service = createConfiguredCaseService(liveConfig(), async () => {
    throw new Error('invalidation must not call fetch');
  });
  assert.equal(typeof service.invalidateReadCaches, 'function');
  assert.doesNotThrow(() => service.invalidateReadCaches({ includeTotals: false }));
});

test('$select contains every field read by the UI using live EntityPropertyName values', () => {
  const params = buildEscalationQuery({ pageSize: 20 });
  const selected = new Set(params.get('$select').split(','));
  const expected = new Set(Object.values(LIVE_FIELD_MAPPING));

  assert.deepEqual(selected, expected);
  assert.equal(selected.has('SourceQueue'), false);
  assert.equal(selected.has('Source_x0020_Queue'), true);
});

test('SharePoint response fields are normalized back to the logical UI model', async () => {
  const service = createConfiguredCaseService(liveConfig(), async () => ({
    ok: true,
    json: async () => ({
      value: [{
        Id: 9,
        Title: 'Mapped case',
        Status: 'Action Required',
        Priority: 'High',
        Source_x0020_Queue: 'Fixture-East',
        Working_x0020_Notes: 'Mapped notes',
      }],
    }),
  }));

  const result = await service.query({ pageSize: 20 });
  assert.equal(result.items[0].SourceQueue, 'Fixture-East');
  assert.equal(result.items[0].WorkingNotes, 'Mapped notes');
});

test('a complete sanitized flow-produced DEMO row selects and normalizes all producer fields', async () => {
  const selected = new Set(buildEscalationQuery({ pageSize: 20 }).get('$select').split(','));
  assert.deepEqual(selected, new Set(Object.values(LIVE_FIELD_MAPPING)));

  const service = createConfiguredCaseService(liveConfig(), async () => ({
    ok: true,
    json: async () => ({ value: [FLOW_PRODUCED_DEMO_ROW] }),
  }));
  const result = await service.query({ pageSize: 20 });

  for (const [field, value] of Object.entries(FLOW_PRODUCER_UI_VALUES)) {
    assert.equal(result.items[0][field], value, `${field} must normalize from its EntityPropertyName`);
  }
});

test('incoming DEMO provenance fields preserve timestamp and never use legacy date or S values', async () => {
  const service = createConfiguredCaseService(liveConfig(), async () => ({
    ok: true,
    json: async () => ({ value: [{
      Id: 17,
      Title: 'Subject from DEMO',
      Reference: 'REF-17',
      Received_x0020_Date_x0020_Time: '2026-07-20T07:31:45Z',
      Received_x0020_Date: '2026-07-20',
      Mailbox: 'Fixture-East mailbox',
      Source_x0020_Queue: 'Fixture-East',
      From: 'sender@example.invalid',
      UniqueKey: 'UK-17',
      Internet_x0020_Message_x0020_ID: '<internet-17>',
      Outlook_x0020_Message_x0020_ID: 'outlook-17',
      Conversation_x0020_ID: 'conversation-17',
      SMarker: 'S-17',
      Status: 'Action Required',
      Priority: 'High',
    }] }),
  }));
  const result = await service.query({ pageSize: 20 });
  const item = result.items[0];
  assert.equal(item.Title, 'Subject from DEMO');
  assert.equal(item.Reference, 'REF-17');
  assert.equal(item.ReceivedDateTime, '2026-07-20T07:31:45Z');
  assert.equal(item.Mailbox, 'Fixture-East mailbox');
  assert.equal(item.SourceQueue, 'Fixture-East');
  assert.equal(item.From, 'sender@example.invalid');
  assert.equal(item.UniqueKey, 'UK-17');
  assert.equal(item.InternetMessageId, '<internet-17>');
  assert.equal(item.OutlookMessageId, 'outlook-17');
  assert.equal(item.ConversationId, 'conversation-17');
  assert.equal(item.SMarker, 'S-17');
  assert.notEqual(LIVE_FIELD_MAPPING.ReceivedDateTime, 'Received_x0020_Date');
  assert.notEqual(item.ReceivedDateTime, item.Received_x0020_Date);
  assert.notEqual(item.SMarker, '.');
});

test('service pages open cases and finds the oldest open case', () => {
  const service = createCaseService([
    { id: 'new', Status: 'In Progress', ReceivedDateTime: '2026-07-03T00:00:00Z' },
    { id: 'old', Status: 'Action Required', ReceivedDateTime: '2026-07-01T00:00:00Z' },
    { id: 'closed', Status: 'Closed', ReceivedDateTime: '2026-06-01T00:00:00Z' },
  ]);
  assert.equal(service.query({ status: 'Open', pageSize: 1 }).total, 2);
  assert.equal(service.query({ status: 'Open', pageSize: 1 }).hasNext, true);
  assert.equal(service.oldestOpen().id, 'old');
});

test('SharePoint query maps Open to the two explicit open statuses only', () => {
  const params = buildEscalationQuery({ status: 'Open', query: "O'Reilly", pageSize: 25 });
  assert.match(params.get('$filter'), /Status eq 'Action Required'/);
  assert.match(params.get('$filter'), /Status eq 'In Progress'/);
  assert.doesNotMatch(params.get('$filter'), /Status ne/);
  assert.match(params.get('$filter'), /O''Reilly/);
  assert.equal(params.get('$top'), '25');
});

test('SharePoint search includes the configured From field with safe OData encoding', () => {
  const params = buildEscalationQuery({ status: 'All', query: "sender.o'reilly@example.invalid" });
  const filter = params.get('$filter');
  assert.match(filter, /substringof\('sender\.o''reilly@example\.invalid',From\)/);
});

test('SharePoint status filters support single, open OR, closed and all combinations', () => {
  const cases = [
    { statuses: ['Action Required'], expected: "Status eq 'Action Required'" },
    { statuses: ['In Progress'], expected: "Status eq 'In Progress'" },
    { statuses: ['Closed'], expected: "Status eq 'Closed'" },
    { statuses: ['Duplicate'], expected: "Status eq 'Duplicate'" },
    { statuses: ['Action Required', 'In Progress'], expected: "Status eq 'Action Required' or Status eq 'In Progress'" },
    { statuses: ['Action Required', 'Closed'], expected: "Status eq 'Action Required' or Status eq 'Closed'" },
    { statuses: ['In Progress', 'Closed'], expected: "Status eq 'In Progress' or Status eq 'Closed'" },
  ];
  for (const { statuses, expected } of cases) {
    assert.match(buildEscalationQuery({ statuses }).get('$filter'), new RegExp(expected.replaceAll(' ', '\\s+')));
  }
  assert.equal(buildEscalationQuery({ statuses: ['Action Required', 'In Progress', 'Closed', 'Duplicate'] }).has('$filter'), false);
  assert.match(buildEscalationQuery({ status: 'None', statuses: [] }).get('$filter'), /1 eq 0/);
});

test('service rejects stale etags with a conflict code', () => {
  const service = createCaseService([{ id: 1, Status: 'Action Required' }]);
  assert.throws(() => service.update(1, { WorkingNotes: 'Changed' }, 'W/"stale"'), (error) => error.code === 'ETAG_CONFLICT');
});

test('pagination controller fetches only the requested chunk and preserves filters across page transitions', () => {
  const calls = [];
  const controller = createCasePaginationController({
    query: (request) => {
      calls.push(request);
      return { items: [`page-${request.page}`], page: request.page, pageSize: request.pageSize, total: 75, hasNext: request.page < 2 };
    },
    initialPageSize: 20,
  });

  controller.setFilters({ status: 'Closed', query: 'vendor' });
  controller.next();

  assert.deepEqual(calls, [
    { status: 'Closed', query: 'vendor', page: 1, pageSize: 20 },
    { status: 'Closed', query: 'vendor', page: 2, pageSize: 20 },
  ]);
  assert.equal(controller.getState().items.length, 1);
  assert.equal(controller.getState().items[0], 'page-2');
});

test('changing page size uses only 10, 20 or 50 and resets to page one', () => {
  const calls = [];
  const controller = createCasePaginationController({
    query: (request) => {
      calls.push(request);
      return { items: [`page-${request.page}`], page: request.page, pageSize: request.pageSize, total: 100, hasNext: true };
    },
    initialPageSize: 10,
  });

  controller.setFilters({ status: 'Open', query: '' });
  controller.next();
  controller.setPageSize(20);

  assert.equal(controller.getState().page, 1);
  assert.equal(controller.getState().pageSize, 20);
  assert.deepEqual(calls.at(-1), { status: 'Open', query: '', page: 1, pageSize: 20 });
  assert.throws(() => controller.setPageSize(25), /10, 20 or 50/);
});

test('pagination boundaries disable transitions without issuing extra full-load requests', () => {
  const calls = [];
  const controller = createCasePaginationController({
    query: (request) => {
      calls.push(request);
      return { items: [`page-${request.page}`], page: request.page, pageSize: request.pageSize, total: 20, hasNext: false };
    },
    initialPageSize: 20,
  });

  controller.setFilters({ status: 'All', query: '' });
  assert.equal(controller.getState().hasPrevious, false);
  assert.equal(controller.getState().hasNext, false);
  controller.previous();
  controller.next();
  assert.equal(calls.length, 1);
  assert.equal(controller.getState().hasPrevious, false);
  assert.equal(controller.getState().hasNext, false);
});

test('service selection only enables mock data when mock mode is explicit', async () => {
  let fetchCalls = 0;
  const mock = createConfiguredCaseService({
    mode: 'mock',
    seed: [{ id: 'mock-seed', UniqueKey: 'MOCK-001' }],
  }, () => { fetchCalls += 1; });
  assert.equal(mock.mode, 'mock');
  assert.equal(mock.query({ pageSize: 20 }).items[0].UniqueKey, 'MOCK-001');

  const live = createConfiguredCaseService(liveConfig(), async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ value: [] }) };
  });
  assert.equal(live.mode, 'sharepoint');
  const liveResult = await live.query({ pageSize: 20 });
  assert.equal(liveResult.items.length, 0);
  assert.doesNotMatch(JSON.stringify(liveResult.items), /MOCK/);
  assert.equal(fetchCalls, 1);
});

test('sharepoint client uses same-origin credentials for reads', async () => {
  const calls = [];
  const client = createSharePointClient(liveConfig(), async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ value: [] }) };
  });

  await client.listItems({ pageSize: 20 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, 'include');
  assert.match(calls[0].url, /getbytitle\('Escalations'\)\/items/);
});

test('SharePoint item readback returns the current item and ETag for conflict refresh', async () => {
  const client = createSharePointClient(liveConfig(), async (url, options) => ({
    ok: true,
    headers: { get: (name) => name === 'ETag' ? 'W/"server-9"' : null },
    json: async () => ({ Id: 9, Status: 'In Progress', Working_x0020_Notes: 'server value' }),
    url,
    options,
  }));
  const item = await client.getItem(9);
  assert.equal(item.Id, 9);
  assert.equal(item.Status, 'In Progress');
  assert.equal(item.__etag, 'W/"server-9"');
});

test('Vendor Finder reads the current Demo Vendor Reference internal fields', async () => {
  const calls = [];
  const service = createConfiguredCaseService(liveConfig({ vendorReferenceListTitle: 'Demo Vendor Reference' }), async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ value: [{ Id: 3, Vendor: 'VEN-3', Vendor_x0020_Name: 'Vendor Three', Vendor_x0020_Category: 'Category Three', Vendor_x0020_Lookup_x0020_Key: 'VEN-3' }] }),
    };
  });
  const results = await service.searchVendorReference('Vendor Three');
  assert.deepEqual(results[0], { id: 3, Title: '', Vendor: 'VEN-3', VendorName: 'Vendor Three', VendorCategory: 'Category Three', VendorLookupKey: 'VEN-3' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /getbytitle\('Demo Vendor Reference'\)\/items/);
  assert.match(calls[0].url, /Vendor_x0020_Name/);
  assert.match(calls[0].url, /Vendor_x0020_Category/);
  assert.match(calls[0].url, /Vendor_x0020_Lookup_x0020_Key/);
  assert.match(calls[0].url, /%24orderby=Id\+asc/);
  assert.match(calls[0].url, /%24top=500/);
  assert.doesNotMatch(calls[0].url, /substringof/i);
  assert.equal(calls[0].options.credentials, 'include');
});

test('sharepoint service follows nextLink for page 20 and page 50 without full-load slicing', async () => {
  const calls = [];
  const nextLink = 'https://fixture.example.invalid/sites/DEMO/_api/web/lists/getbytitle(\'Escalations\')/items?$skiptoken=Paged=TRUE';
  const responses = [
    { value: [{ Id: 1, Title: 'Live 20', Status: 'Action Required' }], '@odata.count': 21, '@odata.nextLink': nextLink },
    { value: [{ Id: 2, Title: 'Live 21', Status: 'Action Required' }], '@odata.count': 21 },
  ];
  const service = createConfiguredCaseService(liveConfig(), async (url) => {
    calls.push(url);
    return { ok: true, json: async () => responses.shift() };
  });

  const first = await service.query({ status: 'Open', page: 1, pageSize: 20 });
  const second = await service.query({ status: 'Open', page: 2, pageSize: 20 });

  assert.equal(first.items[0].Title, 'Live 20');
  assert.equal(second.items[0].Title, 'Live 21');
  assert.equal(second.hasNext, false);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\$skiptoken=Paged=TRUE/);
  assert.doesNotMatch(JSON.stringify(second.items), /MOCK/);

  const pageSizeCalls = [];
  const pageSizeService = createConfiguredCaseService(liveConfig(), async (url) => {
    pageSizeCalls.push(url);
    return { ok: true, json: async () => ({ value: [], '@odata.count': 0 }) };
  });
  await pageSizeService.query({ pageSize: 50 });
  assert.match(pageSizeCalls[0], /%24top=50/);
});

test('sharepoint mode fails closed when the list binding is not verified', async () => {
  const service = createConfiguredCaseService({
    mode: 'sharepoint',
    status: 'TEMPLATE_REBIND_REQUIRED',
    verified: false,
  });

  await assert.rejects(service.query({ pageSize: 20 }), /not verified|configuration/i);
});

test('sharepoint update obtains a request digest and sends mapped ETag-protected MERGE', async () => {
  const calls = [];
  const config = liveConfig({
    fieldMapping: {
      ...liveConfig().fieldMapping,
      Status: 'EscalationStatus',
      WorkingNotes: 'OperatorNotes',
    },
  });
  const client = createSharePointClient(config, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/_api/contextinfo')) {
      return { ok: true, json: async () => ({ d: { GetContextWebInformation: { FormDigestValue: 'digest-value' } } }) };
    }
    return { ok: true, status: 204, headers: { get: () => null }, json: async () => ({}) };
  });

  await client.updateItem(7, { Status: 'Closed', WorkingNotes: 'Updated' }, 'W/"etag-7"');

  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[1].options.headers['IF-MATCH'], 'W/"etag-7"');
  assert.equal(calls[1].options.headers['X-RequestDigest'], 'digest-value');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    EscalationStatus: 'Closed',
    OperatorNotes: 'Updated',
  });
});

test('every explicit save obtains a fresh SharePoint digest and still sends one MERGE only', async () => {
  let digestReads = 0;
  const merges = [];
  const client = createSharePointClient(liveConfig(), async (url, options) => {
    if (String(url).endsWith('/_api/contextinfo')) {
      digestReads += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ FormDigestValue: `digest-${digestReads}`, FormDigestTimeoutSeconds: 1800 }),
      };
    }
    merges.push({ url: String(url), options });
    return { ok: true, status: 204, headers: { get: () => null }, json: async () => ({}) };
  });

  await client.updateItem(1, { WorkingNotes: 'First' }, 'W/"1"');
  await client.updateItem(2, { WorkingNotes: 'Second' }, 'W/"2"');

  assert.equal(digestReads, 2, 'a digest must never remain cached across separate saves');
  assert.equal(merges.length, 2);
  assert.deepEqual(merges.map((call) => call.options.headers['X-RequestDigest']), ['digest-1', 'digest-2']);
  assert.ok(merges.every((call) => call.options.headers['X-HTTP-Method'] === 'MERGE'));
});

test('overlapping saves for different rows own separate digest requests and isolated readbacks', async () => {
  const fixtureDigests = ['transaction-a', 'transaction-b'];
  const contextReleases = [];
  const merges = [];
  const readbacks = [];
  let contextRequests = 0;

  const service = createConfiguredCaseService(liveConfig(), async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/_api/contextinfo')) {
      const slot = contextRequests;
      contextRequests += 1;
      await new Promise((resolve) => { contextReleases[slot] = resolve; });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ FormDigestValue: fixtureDigests[slot] }),
      };
    }

    const itemId = requestUrl.match(/items\(([^)]+)\)/)?.[1];
    if (options.headers?.['X-HTTP-Method'] === 'MERGE') {
      merges.push({
        itemId,
        digest: options.headers['X-RequestDigest'],
        etag: options.headers['IF-MATCH'],
        body: JSON.parse(options.body),
      });
      return { ok: true, status: 204, headers: { get: () => null }, json: async () => ({}) };
    }

    readbacks.push(itemId);
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => String(name).toLowerCase() === 'etag' ? `W/"${itemId}-2"` : null },
      json: async () => ({ Id: Number(itemId), Working_x0020_Notes: `row-${itemId}` }),
    };
  });
  const saves = createItemSaveCoordinator({
    service,
    maxPollAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterRatio: 0,
    wait: async () => {},
  });

  const rowA = saves.save({ itemId: 1, patch: { WorkingNotes: 'row-1' }, etag: 'W/"1-1"' });
  const rowB = saves.save({ itemId: 2, patch: { WorkingNotes: 'row-2' }, etag: 'W/"2-1"' });
  await Promise.resolve();
  await Promise.resolve();
  contextReleases[1]?.();
  await Promise.resolve();
  contextReleases[0]?.();
  await Promise.all([rowA.completion, rowB.completion]);

  assert.equal(contextRequests, 2, 'each overlapping explicit Save must issue its own contextinfo request');
  assert.equal(merges.length, 2, 'each explicit Save must issue exactly one MERGE');
  assert.equal(readbacks.length, 2, 'each successful MERGE must have one isolated readback GET');
  const byItem = new Map(merges.map((entry) => [entry.itemId, entry]));
  assert.deepEqual([...byItem.keys()].sort(), ['1', '2']);
  assert.ok(byItem.get('1').digest === fixtureDigests[0], 'row 1 must use its own digest response');
  assert.ok(byItem.get('2').digest === fixtureDigests[1], 'row 2 must use its own digest response');
  assert.equal(byItem.get('1').etag, 'W/"1-1"');
  assert.equal(byItem.get('2').etag, 'W/"2-1"');
  assert.deepEqual(byItem.get('1').body, { Working_x0020_Notes: 'row-1' });
  assert.deepEqual(byItem.get('2').body, { Working_x0020_Notes: 'row-2' });
  assert.deepEqual(readbacks.sort(), ['1', '2']);
  assert.deepEqual([rowA.state, rowB.state], ['Confirmed', 'Confirmed']);
  assert.deepEqual([rowA.error, rowB.error], [null, null]);
});

test('a 403 exposes the SharePoint reason and never retries the item MERGE', async () => {
  let mergeCalls = 0;
  const client = createSharePointClient(liveConfig(), async (url) => {
    if (String(url).endsWith('/_api/contextinfo')) {
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ FormDigestValue: 'fresh-digest', FormDigestTimeoutSeconds: 1800 }),
      };
    }
    mergeCalls += 1;
    return {
      ok: false, status: 403, headers: { get: () => null },
      json: async () => ({ error: { message: { value: 'The security validation for this page is invalid.' } } }),
    };
  });

  await assert.rejects(
    client.updateItem(7, { WorkingNotes: 'No duplicate write' }, 'W/"7"'),
    /security validation for this page is invalid.*403/i,
  );
  assert.equal(mergeCalls, 1);
});

test('HTTP 409 preserves the draft and exposes the established Conflict Refresh / Compare path without retrying MERGE', async () => {
  let mergeCalls = 0;
  let readCalls = 0;
  const client = createSharePointClient(liveConfig(), async (url, options = {}) => {
    if (String(url).endsWith('/_api/contextinfo')) {
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ FormDigestValue: 'fresh-conflict-digest' }),
      };
    }
    if (options.headers?.['X-HTTP-Method'] === 'MERGE') {
      mergeCalls += 1;
      return {
        ok: false, status: 409, headers: { get: () => null },
        json: async () => ({ error: { message: { value: 'The item was changed by another user.' } } }),
      };
    }
    readCalls += 1;
    throw new Error('a rejected MERGE must not start authoritative readback');
  });
  const coordinator = createItemSaveCoordinator({
    service: {
      update: (id, patch, etag) => client.updateItem(id, patch, etag),
      get: async () => { readCalls += 1; return {}; },
    },
    maxPollAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterRatio: 0,
  });
  const pendingDraft = { WorkingNotes: 'local draft' };
  const transaction = coordinator.save({
    itemId: 7,
    patch: pendingDraft,
    etag: 'W/"7-1"',
    uiState: { draft: pendingDraft },
  });

  await transaction.completion;

  assert.equal(transaction.state, 'Conflict');
  assert.equal(transaction.error?.code, 'ETAG_CONFLICT');
  assert.equal(transaction.error?.status, 409);
  assert.match(transaction.error?.message ?? '', /changed by another user/i);
  assert.deepEqual(transaction.snapshot.patch, pendingDraft);
  assert.deepEqual(transaction.snapshot.uiState.draft, pendingDraft);
  assert.equal(Object.isFrozen(transaction.snapshot.patch), true);
  assert.equal(mergeCalls, 1, 'the rejected explicit Save must issue one MERGE only');
  assert.equal(readCalls, 0, 'a rejected MERGE must not enter GET confirmation polling');
  await assert.rejects(() => coordinator.retry(7), /No submitted PATCH/i);
  assert.equal(mergeCalls, 1, 'conflict retry must never resend MERGE');

  const item = { id: 7, Status: 'In Progress', WorkingNotes: 'server value', __etag: 'W/"7-1"', __editHydrationStatus: 'ready' };
  const detailMarkup = renderCaseDetail(item, [item], { governedValues: {} });
  const rowMarkup = renderTable([item], 7, new Map([['7', transaction]]));
  assert.match(detailMarkup, /id="conflict-actions"[^>]*hidden/);
  assert.match(detailMarkup, /id="refresh-compare"[^>]*>Refresh \/ Compare<\/button>/);
  assert.match(rowMarkup, /Resolve conflict/);
});
