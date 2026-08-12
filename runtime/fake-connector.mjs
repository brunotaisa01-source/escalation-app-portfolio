import { createCaseService } from '../frontend/src/services/case-service.js';

const LIST_CASES = 'Demo Escalations';
const LIST_VENDORS = 'Demo Vendor Reference';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dedupeBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = String(item?.[key] ?? '');
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function validateCase(item) {
  const required = ['UniqueKey', 'Status', 'Priority', 'ReceivedDateTime', 'SourceQueue'];
  const missing = required.filter((field) => item?.[field] === undefined || item?.[field] === null || item[field] === '');
  return { valid: missing.length === 0, missing };
}

function validateVendor(item) {
  const required = ['Vendor', 'VendorName', 'VendorCategory', 'VendorLookupKey'];
  const missing = required.filter((field) => item?.[field] === undefined || item?.[field] === null || item[field] === '');
  return { valid: missing.length === 0, missing };
}

function ensureList(state, listName) {
  state.lists[listName] ??= { fields: [], views: [], items: [] };
  return state.lists[listName];
}

function listNameFromUri(uri) {
  return /getbytitle\('([^']+)'\)/iu.exec(String(uri ?? ''))?.[1] ?? null;
}

function planWithOutputs(fixturePlan, outputs) {
  const plan = clone(fixturePlan);
  const successfulAttempt = [...(plan.attempts ?? [])].reverse().find(({ status }) => status === 'Succeeded');
  if (successfulAttempt) successfulAttempt.outputs = outputs;
  return plan;
}

function caseFromSharePointBody(body, id) {
  return {
    id,
    UniqueKey: body.UniqueKey,
    OriginalUniqueKey: body.Original_x0020_UniqueKey,
    Title: body.Title ?? body.Reference,
    Mailbox: body.Mailbox,
    SourceQueue: body.Source_x0020_Queue,
    From: body.From,
    Reference: body.Reference,
    ReceivedDateTime: body.Received_x0020_Date_x0020_Time,
    InternetMessageId: body.Internet_x0020_Message_x0020_ID,
    OutlookMessageId: body.Outlook_x0020_Message_x0020_ID,
    ConversationId: body.Conversation_x0020_ID,
    SMarker: body.SMarker,
    Vendor: body.Vendor,
    VendorName: body.Vendor_x0020_Name,
    VendorCategory: body.Vendor_x0020_Category,
    Entity: body.Entity,
    DocDate: body.Doc_x0020_Date,
    InvRef: body.Inv_x0020_Ref,
    Value: body.Value,
    ActionType: body.Action_x0020_Type,
    Priority: body.Priority,
    APOwner: body.AP_x0020_Owner,
    EscalationDate: body.Escalation_x0020_Date,
    WorkingNotes: body.Working_x0020_Notes,
    DateResolved: body.Date_x0020_Resolved,
    Status: body.Status,
    DaysToResolve: body.Days_x0020_To_x0020_Resolve,
    IsClosed: body.Is_x0020_Closed,
  };
}

function vendorFromSharePointBody(body) {
  return {
    Vendor: body.Vendor,
    VendorName: body.Vendor_x0020_Name,
    VendorCategory: body.Vendor_x0020_Category,
    VendorLookupKey: body.Vendor_x0020_Lookup_x0020_Key,
  };
}

function caseFromEtlRow(parameters, messages, id) {
  const uniqueKey = parameters['item/UniqueKey'];
  const message = messages.find(({ internetMessageId }) => internetMessageId === uniqueKey) ?? {};
  return {
    id,
    UniqueKey: uniqueKey,
    Title: message.subject ?? parameters['item/Reference'],
    Mailbox: parameters['item/Mailbox'],
    SourceQueue: parameters['item/Mailbox'],
    From: parameters['item/From '],
    Reference: parameters['item/Reference'],
    ReceivedDateTime: message.receivedDateTime ?? '2026-01-15T00:00:00Z',
    InternetMessageId: parameters['item/Internet_Message_ID'],
    Vendor: '',
    VendorName: '',
    VendorCategory: '',
    Entity: 'Fixture Entity',
    DocDate: null,
    InvRef: parameters['item/Inv ref'] === '-' ? '' : parameters['item/Inv ref'],
    Value: null,
    ActionType: parameters['item/Action_Type'] === '-' ? 'Fixture ETL' : parameters['item/Action_Type'],
    Priority: 'Medium',
    APOwner: 'Fixture Owner 00',
    EscalationDate: message.receivedDateTime ?? '2026-01-15T00:00:00Z',
    WorkingNotes: 'Created from an executed fixture flow.',
    DateResolved: null,
    Status: parameters['item/Status'],
    DaysToResolve: null,
    IsClosed: false,
  };
}

export function createFakeConnector({ initialCases = [], initialVendors = [] } = {}) {
  const state = {
    lists: {
      [LIST_CASES]: { fields: [], views: [], items: [] },
      [LIST_VENDORS]: { fields: [], views: [], items: [] },
    },
    access: { mode: 'fixture-only', bindings: [] },
    history: [],
    etlRows: [],
    messages: [],
    connectorEffects: [],
    flowExecutions: [],
  };

  const record = (step, details = {}) => {
    state.history.push({ step, status: 'LOCAL_MOCK_GREEN', ...details });
  };

  return {
    mode: 'local-mock',
    async bootstrap() {
      state.lists[LIST_CASES].fields = ['UniqueKey', 'Status', 'Priority', 'ReceivedDateTime', 'SourceQueue', 'Vendor'];
      state.lists[LIST_VENDORS].fields = ['VendorLookupKey', 'VendorName', 'VendorCategory'];
      record('bootstrap-lists', { listCount: 2, fieldCount: 9 });
      return { status: 'LOCAL_MOCK_GREEN', listCount: 2 };
    },
    async applyColumnsAndViews() {
      state.lists[LIST_CASES].views = ['Open', 'Closed', 'All'];
      state.lists[LIST_VENDORS].views = ['Reference'];
      record('add-columns-and-views', { viewCount: 4 });
      return { status: 'LOCAL_MOCK_GREEN', viewCount: 4 };
    },
    async applyAccessBindings() {
      state.access.bindings = [
        { principal: 'fixture.operator@example.invalid', role: 'operator' },
        { principal: 'fixture.reader@example.invalid', role: 'reader' },
      ];
      record('user-access-matrix', { bindingCount: state.access.bindings.length, compensation: 'available' });
      return { status: 'LOCAL_MOCK_GREEN', bindingCount: state.access.bindings.length };
    },
    async loadVendors(records = initialVendors, { dryRun = false } = {}) {
      const valid = records.filter((item) => validateVendor(item).valid);
      const rejected = records.length - valid.length;
      if (!dryRun) state.lists[LIST_VENDORS].items = dedupeBy([...state.lists[LIST_VENDORS].items, ...clone(valid)], 'VendorLookupKey');
      record('seed-vendors', { input: records.length, loaded: valid.length, rejected, dryRun });
      return { status: 'LOCAL_MOCK_GREEN', input: records.length, loaded: valid.length, rejected, dryRun };
    },
    async loadCases(records = initialCases, { dryRun = false } = {}) {
      const valid = records.filter((item) => validateCase(item).valid);
      const rejected = records.length - valid.length;
      if (!dryRun) state.lists[LIST_CASES].items = dedupeBy([...state.lists[LIST_CASES].items, ...clone(valid)], 'UniqueKey');
      record('seed-cases', { input: records.length, loaded: valid.length, rejected, dryRun });
      return { status: 'LOCAL_MOCK_GREEN', input: records.length, loaded: valid.length, rejected, dryRun };
    },
    async ingestMessage(message) {
      const item = {
        id: 100,
        UniqueKey: message.uniqueKey,
        Title: message.subject,
        Mailbox: message.mailbox,
        SourceQueue: message.sourceQueue,
        From: message.from,
        Reference: message.reference,
        ReceivedDateTime: message.receivedDateTime,
        InternetMessageId: message.internetMessageId,
        Vendor: message.vendor,
        VendorName: message.vendorName,
        VendorCategory: message.vendorCategory,
        Entity: message.entity,
        DocDate: message.docDate,
        InvRef: message.invoiceReference,
        Value: message.value,
        ActionType: message.actionType,
        Priority: message.priority,
        APOwner: message.owner,
        EscalationDate: message.receivedDateTime,
        WorkingNotes: 'Generated by the deterministic local ingest fixture.',
        Status: 'Action Required',
        IsClosed: false,
      };
      const check = validateCase(item);
      if (!check.valid) throw new Error(`Fixture ingest validation failed: ${check.missing.join(', ')}`);
      const existing = state.lists[LIST_CASES].items.some((candidate) => candidate.UniqueKey === item.UniqueKey);
      if (!existing) state.lists[LIST_CASES].items.push(item);
      record('ingest-message', { deduplicated: existing, loaded: existing ? 0 : 1 });
      return { status: 'LOCAL_MOCK_GREEN', deduplicated: existing, loaded: existing ? 0 : 1 };
    },
    flowAdapter() {
      return {
        transport: 'local-state',
        plan({ actionPath, operationId, inputs, fixturePlan }) {
          const parameters = inputs?.parameters ?? {};
          const uri = parameters['parameters/uri'];
          if (actionPath.endsWith('/Find_existing_unique_key')) {
            const listName = listNameFromUri(uri);
            const decodedUri = decodeURIComponent(String(uri));
            const lookupValue = /\beq\s+'([^']+)'/iu.exec(decodedUri)?.[1];
            const key = listName === LIST_CASES ? 'UniqueKey' : 'VendorLookupKey';
            const existing = ensureList(state, listName).items.find((item) => String(item[key]) === lookupValue);
            return planWithOutputs(fixturePlan, { statusCode: 200, body: { value: existing ? [{ Id: existing.id ?? 1, [key]: lookupValue }] : [] } });
          }
          if (operationId === 'GetItems') {
            return planWithOutputs(fixturePlan, { statusCode: 200, body: { value: clone(state.etlRows) } });
          }
          return fixturePlan;
        },
        commit(call) {
          state.connectorEffects.push(call);
          if (call.status !== 'Succeeded') return;
          const parameters = call.inputs?.parameters ?? {};
          const uri = parameters['parameters/uri'];
          const method = parameters['parameters/method'];
          const body = parameters['parameters/body'] ?? {};
          if (call.operationId === 'GetEmailsV3') {
            state.messages = dedupeBy([...state.messages, ...clone(call.outputs?.body?.value ?? [])], 'internetMessageId');
          } else if (call.operationId === 'AddRowV2') {
            const uniqueKey = parameters['item/UniqueKey'];
            if (!state.etlRows.some((row) => row.UniqueKey === uniqueKey)) {
              const row = Object.fromEntries(Object.entries(parameters)
                .filter(([key]) => key.startsWith('item/'))
                .map(([key, value]) => [key.slice(5).trim(), value]));
              state.etlRows.push({ ...row, UniqueKey: uniqueKey });
              const list = ensureList(state, LIST_CASES);
              const item = caseFromEtlRow(parameters, state.messages, 100 + state.etlRows.length - 1);
              if (validateCase(item).valid) list.items.push(item);
            }
          } else if (call.operationId === 'HttpRequest' && method === 'POST' && uri === '_api/web/lists') {
            ensureList(state, body.Title);
          } else if (call.operationId === 'HttpRequest' && method === 'POST' && /\/fields\/CreateFieldAsXml$/iu.test(uri)) {
            const list = ensureList(state, listNameFromUri(uri));
            const fieldName = /\bName='([^']+)'/u.exec(body?.parameters?.SchemaXml ?? '')?.[1];
            if (fieldName && !list.fields.includes(fieldName)) list.fields.push(fieldName);
          } else if (call.operationId === 'HttpRequest' && method === 'POST' && /\/items$/iu.test(uri)) {
            const listName = listNameFromUri(uri);
            const list = ensureList(state, listName);
            if (listName === LIST_CASES) {
              const item = caseFromSharePointBody(body, list.items.length + 1);
              if (validateCase(item).valid && !list.items.some(({ UniqueKey }) => UniqueKey === item.UniqueKey)) list.items.push(item);
            } else if (listName === LIST_VENDORS) {
              const item = vendorFromSharePointBody(body);
              if (validateVendor(item).valid && !list.items.some(({ VendorLookupKey }) => VendorLookupKey === item.VendorLookupKey)) list.items.push(item);
            }
          } else if (call.flow === 'add-columns-and-views' && method === 'POST') {
            const list = ensureList(state, listNameFromUri(uri));
            const viewName = body?.parameters?.viewName ?? body?.Title;
            if (viewName && !list.views.includes(viewName)) list.views.push(viewName);
          } else if (call.flow === 'user-access-matrix' && call.actionPath.endsWith('/Add_role_assignment')) {
            const binding = { actionPath: call.actionPath, uri };
            if (!state.access.bindings.some((item) => item.uri === uri)) state.access.bindings.push(binding);
          }
        },
        onFlowComplete(result) {
          state.flowExecutions.push({
            flow: result.flow,
            status: result.executionStatus,
            tenantCalls: result.tenantCalls,
            connectorCallCount: result.connectorCallCount,
            attempts: result.connectorCalls.reduce((total, call) => total + call.attempts, 0),
            errors: result.connectorCalls.filter(({ error }) => error).map(({ actionPath, error }) => ({ actionPath, error })),
            branches: result.branches,
            outputs: result.outputs,
          });
          record(result.flow, { connectorCallCount: result.connectorCallCount, executionStatus: result.executionStatus });
        },
      };
    },
    queryCases(request = {}) {
      const service = createCaseService(state.lists[LIST_CASES].items);
      return service.query(request);
    },
    dashboard(request = {}) {
      const service = createCaseService(state.lists[LIST_CASES].items);
      return { counts: service.counts(), page: service.query({ ...request, page: 1, pageSize: request.pageSize ?? 10 }) };
    },
    exportCases(request = {}) {
      const service = createCaseService(state.lists[LIST_CASES].items);
      return service.exportAll(request);
    },
    snapshot() {
      return clone(state);
    },
  };
}

export { LIST_CASES, LIST_VENDORS, validateCase, validateVendor };
