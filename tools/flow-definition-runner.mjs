const SUPPORTED_TRIGGERS = new Set(['Request', 'Recurrence', 'OpenApiConnection']);
const SUPPORTED_ACTIONS = new Set([
  'Compose',
  'Foreach',
  'If',
  'InitializeVariable',
  'OpenApiConnection',
  'Query',
  'Scope',
  'SetVariable',
  'Terminate',
  'Wait',
]);
const SUPPORTED_FUNCTIONS = new Set([
  'and', 'body', 'coalesce', 'concat', 'contains', 'convertTimeZone', 'dayOfWeek', 'empty',
  'encodeUriComponent', 'equals', 'formatDateTime', 'greaterOrEquals', 'int', 'item', 'items',
  'length', 'lessOrEquals', 'not', 'outputs', 'parameters', 'replace', 'string', 'toLower',
  'triggerBody', 'trim', 'utcNow', 'variables',
]);
const TERMINAL_STATUSES = new Set(['Succeeded', 'Failed', 'TimedOut', 'Skipped']);
const WINDOWS_TIME_ZONES = new Map([
  ['GMT Standard Time', 'Europe/London'],
  ['Europe/London', 'Europe/London'],
]);
const zonedFormatters = new Map();

export class FlowExecutionError extends Error {
  constructor({ flow, definitionPath, actionPath, reason }) {
    super(`${flow} ${definitionPath} ${actionPath}: ${reason}`);
    this.name = 'FlowExecutionError';
    this.flow = flow;
    this.definitionPath = definitionPath;
    this.actionPath = actionPath;
    this.reason = reason;
  }
}

function fail(context, actionPath, reason) {
  throw new FlowExecutionError({
    flow: context.flow,
    definitionPath: context.definitionPath,
    actionPath,
    reason,
  });
}

function pathJoin(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}

function countActions(actions) {
  let count = 0;
  for (const action of Object.values(actions ?? {})) {
    count += 1;
    count += countActions(action.actions);
    count += countActions(action.else?.actions);
    for (const item of Object.values(action.cases ?? {})) count += countActions(item.actions);
    count += countActions(action.default?.actions);
  }
  return count;
}

function countActionsOfType(actions, type) {
  let count = 0;
  for (const action of Object.values(actions ?? {})) {
    if (action.type === type) count += 1;
    count += countActionsOfType(action.actions, type);
    count += countActionsOfType(action.else?.actions, type);
    for (const item of Object.values(action.cases ?? {})) count += countActionsOfType(item.actions, type);
    count += countActionsOfType(action.default?.actions, type);
  }
  return count;
}

function countExpressions(value) {
  if (typeof value === 'string') return value.trimStart().startsWith('@') ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countExpressions(item), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((total, item) => total + countExpressions(item), 0);
  return 0;
}

function stripQuotedLiterals(expression) {
  let output = '';
  let quoted = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "'") {
      if (quoted && expression[index + 1] === "'") {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (!quoted) output += character;
  }
  return output;
}

function validateExpressionFunctions(value, context, actionPath) {
  if (typeof value === 'string') {
    if (!value.trimStart().startsWith('@')) return;
    const unquoted = stripQuotedLiterals(value);
    for (const match of unquoted.matchAll(/\b([A-Za-z][A-Za-z0-9]*)\s*\(/g)) {
      if (!SUPPORTED_FUNCTIONS.has(match[1])) fail(context, actionPath, `unsupported expression function ${match[1]}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateExpressionFunctions(item, context, actionPath);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) validateExpressionFunctions(item, context, actionPath);
  }
}

function connectionKeyForHost(host, context, actionPath) {
  if (!host || typeof host !== 'object') fail(context, actionPath, 'connected operation is missing inputs.host');
  const references = context.connectionReferences;
  const match = Object.entries(references).find(([key, reference]) => (
    key === host.connectionName
    || (reference?.id === host.apiId && reference?.connectionName === host.connectionName)
  ));
  if (!match) fail(context, actionPath, `connection reference not found for ${host.connectionName ?? host.apiId ?? '<unknown>'}`);
  const [key] = match;
  if (typeof context.apisMap[key] !== 'string') fail(context, actionPath, `apis map is missing ${key}`);
  if (typeof context.connectionsMap[key] !== 'string') fail(context, actionPath, `connections map is missing ${key}`);
  return key;
}

function validateCollection(actions, prefix, context) {
  const names = new Set(Object.keys(actions ?? {}));
  for (const [name, action] of Object.entries(actions ?? {})) {
    const actionPath = pathJoin(prefix, name);
    if (!SUPPORTED_ACTIONS.has(action.type)) fail(context, actionPath, `unsupported action type ${action.type}`);
    for (const [dependency, statuses] of Object.entries(action.runAfter ?? {})) {
      if (!names.has(dependency)) fail(context, actionPath, `runAfter references missing action ${dependency}`);
      if (!Array.isArray(statuses) || statuses.some((status) => !TERMINAL_STATUSES.has(status))) {
        fail(context, actionPath, `runAfter for ${dependency} contains unsupported statuses`);
      }
    }
    validateExpressionFunctions(action, context, actionPath);
    if (action.type === 'OpenApiConnection') connectionKeyForHost(action.inputs?.host, context, actionPath);
    validateCollection(action.actions, actionPath, context);
    validateCollection(action.else?.actions, `${actionPath}/else`, context);
    for (const [caseName, item] of Object.entries(action.cases ?? {})) {
      validateCollection(item.actions, `${actionPath}/case:${caseName}`, context);
    }
    validateCollection(action.default?.actions, `${actionPath}/default`, context);
  }
}

class ExpressionParser {
  constructor(expression, context, actionPath) {
    this.source = expression.trim().replace(/^@/, '');
    this.index = 0;
    this.context = context;
    this.actionPath = actionPath;
  }

  parse() {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) this.error(`unexpected token ${this.source.slice(this.index, this.index + 12)}`);
    return value;
  }

  error(reason) {
    fail(this.context, this.actionPath, `expression ${JSON.stringify(this.source)}: ${reason}`);
  }

  skipWhitespace() {
    while (/\s/.test(this.source[this.index] ?? '')) this.index += 1;
  }

  parseValue() {
    this.skipWhitespace();
    const character = this.source[this.index];
    let value;
    if (character === "'") value = this.parseString();
    else if (character === '-' || /\d/.test(character ?? '')) value = this.parseNumber();
    else value = this.parseIdentifierValue();
    return this.parseAccessors(value);
  }

  parseString() {
    this.index += 1;
    let value = '';
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === "'") {
        if (this.source[this.index + 1] === "'") {
          value += "'";
          this.index += 2;
          continue;
        }
        this.index += 1;
        return value;
      }
      value += character;
      this.index += 1;
    }
    this.error('unterminated string literal');
  }

  parseNumber() {
    const match = this.source.slice(this.index).match(/^-?\d+(?:\.\d+)?/);
    if (!match) this.error('invalid number');
    this.index += match[0].length;
    return Number(match[0]);
  }

  parseIdentifierValue() {
    const match = this.source.slice(this.index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (!match) this.error('expected a value');
    const identifier = match[0];
    this.index += identifier.length;
    this.skipWhitespace();
    if (this.source[this.index] !== '(') {
      if (identifier === 'true') return true;
      if (identifier === 'false') return false;
      if (identifier === 'null') return null;
      this.error(`unsupported identifier ${identifier}`);
    }
    this.index += 1;
    const args = [];
    this.skipWhitespace();
    if (this.source[this.index] !== ')') {
      while (true) {
        args.push(this.parseValue());
        this.skipWhitespace();
        if (this.source[this.index] === ',') {
          this.index += 1;
          continue;
        }
        break;
      }
    }
    if (this.source[this.index] !== ')') this.error(`missing closing parenthesis for ${identifier}`);
    this.index += 1;
    return callExpressionFunction(identifier, args, this.context, this.actionPath);
  }

  parseAccessors(initialValue) {
    let value = initialValue;
    while (true) {
      this.skipWhitespace();
      let optional = false;
      if (this.source[this.index] === '?') {
        optional = true;
        this.index += 1;
      }
      if (this.source[this.index] !== '[') {
        if (optional) this.error('optional marker must precede a property accessor');
        break;
      }
      this.index += 1;
      this.skipWhitespace();
      const key = this.source[this.index] === "'" ? this.parseString() : this.parseNumber();
      this.skipWhitespace();
      if (this.source[this.index] !== ']') this.error('missing closing property bracket');
      this.index += 1;
      if (value === null || value === undefined) {
        if (optional) value = null;
        else this.error(`cannot read property ${key} from ${value}`);
      } else {
        const segments = typeof key === 'string' ? key.split('/') : [key];
        for (const segment of segments) value = value?.[segment];
      }
    }
    return value;
  }
}

function isEmpty(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function stringifyWorkflowValue(value) {
  if (value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function zonedParts(value) {
  const cacheKey = value.timeZone;
  if (!zonedFormatters.has(cacheKey)) {
    zonedFormatters.set(cacheKey, new Intl.DateTimeFormat('en-GB', {
      timeZone: value.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }));
  }
  return Object.fromEntries(zonedFormatters.get(cacheKey).formatToParts(new Date(value.instantMs))
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value: part }) => [type, Number(part)]));
}

function convertWorkflowTimeZone(value, sourceZone, targetZone, context, actionPath) {
  if (sourceZone !== 'UTC') fail(context, actionPath, `unsupported source time zone ${sourceZone}`);
  const timeZone = WINDOWS_TIME_ZONES.get(targetZone);
  if (!timeZone) fail(context, actionPath, `unsupported time zone ${targetZone}`);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail(context, actionPath, `invalid date-time ${JSON.stringify(value)}`);
  return Object.freeze({ __workflowZonedDateTime: true, instantMs: date.getTime(), timeZone });
}

function formatWorkflowDate(value, format) {
  if (value?.__workflowZonedDateTime === true) {
    const parts = zonedParts(value);
    const pad = (number) => String(number).padStart(2, '0');
    if (format === 'HHmm') return `${pad(parts.hour)}${pad(parts.minute)}`;
    if (format === 'dd/MM/yyyy') return `${pad(parts.day)}/${pad(parts.month)}/${parts.year}`;
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  if (format === 'HHmm') return `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
  if (format === 'dd/MM/yyyy') return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
  return date.toISOString();
}

function callExpressionFunction(name, args, context, actionPath) {
  if (!SUPPORTED_FUNCTIONS.has(name)) fail(context, actionPath, `unsupported expression function ${name}`);
  const functions = {
    and: (...values) => values.every(Boolean),
    body: (actionName) => {
      const output = context.outputs[actionName];
      return output && typeof output === 'object' && Object.hasOwn(output, 'body') ? output.body : output;
    },
    coalesce: (...values) => values.find((value) => value !== null && value !== undefined),
    concat: (...values) => values.map((value) => value ?? '').join(''),
    contains: (container, value) => (Array.isArray(container)
      ? container.includes(value)
      : stringifyWorkflowValue(container).includes(stringifyWorkflowValue(value))),
    convertTimeZone: (value, sourceZone, targetZone) => convertWorkflowTimeZone(value, sourceZone, targetZone, context, actionPath),
    dayOfWeek: (value) => {
      if (value?.__workflowZonedDateTime === true) {
        const parts = zonedParts(value);
        return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
      }
      return new Date(value).getUTCDay();
    },
    empty: (value) => isEmpty(value),
    encodeUriComponent: (value) => encodeURIComponent(stringifyWorkflowValue(value)),
    equals: (left, right) => left === right,
    formatDateTime: (value, format) => formatWorkflowDate(value, format),
    greaterOrEquals: (left, right) => left >= right,
    int: (value) => Number.parseInt(value, 10),
    item: () => context.currentItem,
    items: (loopName) => context.loopItems[loopName],
    length: (value) => (value?.length ?? Object.keys(value ?? {}).length),
    lessOrEquals: (left, right) => left <= right,
    not: (value) => !value,
    outputs: (actionName) => context.outputs[actionName],
    parameters: (parameterName) => context.parameters[parameterName],
    replace: (value, search, replacement) => stringifyWorkflowValue(value).split(stringifyWorkflowValue(search)).join(stringifyWorkflowValue(replacement)),
    string: (value) => stringifyWorkflowValue(value),
    toLower: (value) => stringifyWorkflowValue(value).toLowerCase(),
    triggerBody: () => context.triggerInput,
    trim: (value) => stringifyWorkflowValue(value).trim(),
    utcNow: () => context.deterministicNow,
    variables: (variableName) => context.variables[variableName],
  };
  return functions[name](...args);
}

function evaluateExpression(expression, context, actionPath) {
  return new ExpressionParser(expression, context, actionPath).parse();
}

function evaluateValue(value, context, actionPath) {
  if (typeof value === 'string') return value.trimStart().startsWith('@') ? evaluateExpression(value, context, actionPath) : value;
  if (Array.isArray(value)) return value.map((item) => evaluateValue(item, context, actionPath));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluateValue(item, context, actionPath)]));
  }
  return value;
}

function evaluateCondition(value, context, actionPath) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1 && SUPPORTED_FUNCTIONS.has(entries[0][0])) {
      const [operator, operands] = entries[0];
      const args = Array.isArray(operands) ? operands.map((item) => evaluateCondition(item, context, actionPath)) : [evaluateCondition(operands, context, actionPath)];
      return callExpressionFunction(operator, args, context, actionPath);
    }
  }
  return evaluateValue(value, context, actionPath);
}

function connectorPlan(actionPath, action, inputs, context) {
  const responses = context.fixture.connectorResponses ?? {};
  if (Object.hasOwn(responses, '*')) fail(context, actionPath, 'wildcard connector fixtures are prohibited');
  const operationKey = `operation:${action.inputs?.host?.operationId}`;
  const fixturePlan = responses[actionPath] ?? responses[operationKey];
  if (!fixturePlan) fail(context, actionPath, `explicit connector fixture is missing for ${actionPath} or ${operationKey}`);
  const adaptedPlan = context.connectorAdapter?.plan?.({
    flow: context.flow,
    actionPath,
    operationId: action.inputs?.host?.operationId ?? null,
    inputs: structuredClone(inputs),
    fixturePlan: structuredClone(fixturePlan),
  });
  return adaptedPlan ?? fixturePlan;
}

function executeConnector(action, actionPath, context) {
  const connectionKey = connectionKeyForHost(action.inputs?.host, context, actionPath);
  const inputs = evaluateValue(action.inputs, context, actionPath);
  const plan = connectorPlan(actionPath, action, inputs, context);
  if (!Array.isArray(plan.attempts) || plan.attempts.length === 0) fail(context, actionPath, 'connector fixture requires at least one attempt');
  const retryPolicy = action.runtimeConfiguration?.retryPolicy;
  const maximumAttempts = retryPolicy && retryPolicy.type !== 'none' ? Number(retryPolicy.count ?? 0) + 1 : 1;
  let finalAttempt;
  let attempts = 0;
  for (const attempt of plan.attempts.slice(0, maximumAttempts)) {
    finalAttempt = attempt;
    attempts += 1;
    if (attempt.status === 'Succeeded') break;
  }
  if (!finalAttempt || !TERMINAL_STATUSES.has(finalAttempt.status)) fail(context, actionPath, 'connector fixture has an unsupported status');
  const call = {
    flow: context.flow,
    actionPath,
    operationId: action.inputs?.host?.operationId ?? null,
    connectionKey,
    inputs,
    outputs: finalAttempt.outputs ?? null,
    error: finalAttempt.error ?? null,
    status: finalAttempt.status,
    attempts,
    transport: context.connectorAdapter?.transport ?? 'local-fixture',
  };
  context.connectorCalls.push(call);
  context.connectorAdapter?.commit?.(structuredClone(call));
  return { status: call.status, output: call.outputs ?? { error: call.error } };
}

function executeAction(name, action, actionPath, context) {
  if (action.type === 'InitializeVariable') {
    for (const variable of action.inputs?.variables ?? []) context.variables[variable.name] = evaluateValue(variable.value, context, actionPath);
    return { status: 'Succeeded', output: Object.fromEntries((action.inputs?.variables ?? []).map(({ name: variableName }) => [variableName, context.variables[variableName]])) };
  }
  if (action.type === 'SetVariable') {
    const value = evaluateValue(action.inputs?.value, context, actionPath);
    context.variables[action.inputs?.name] = value;
    return { status: 'Succeeded', output: value };
  }
  if (action.type === 'Compose') return { status: 'Succeeded', output: evaluateValue(action.inputs, context, actionPath) };
  if (action.type === 'Wait') return { status: 'Succeeded', output: evaluateValue(action.inputs, context, actionPath) };
  if (action.type === 'OpenApiConnection') return executeConnector(action, actionPath, context);
  if (action.type === 'Query') {
    const source = evaluateValue(action.inputs?.from, context, actionPath);
    if (!Array.isArray(source)) fail(context, actionPath, 'Query inputs.from must evaluate to an array');
    const previousItem = context.currentItem;
    const output = source.filter((item) => {
      context.currentItem = item;
      return Boolean(evaluateCondition(action.inputs?.where, context, actionPath));
    });
    context.currentItem = previousItem;
    return { status: 'Succeeded', output: { body: output } };
  }
  if (action.type === 'Foreach') {
    const items = evaluateValue(action.foreach, context, actionPath);
    if (!Array.isArray(items)) fail(context, actionPath, 'Foreach expression must evaluate to an array');
    const previousItem = context.currentItem;
    const previousLoopItem = context.loopItems[name];
    let status = 'Succeeded';
    for (let index = 0; index < items.length; index += 1) {
      context.currentItem = items[index];
      context.loopItems[name] = items[index];
      const iteration = executeCollection(action.actions ?? {}, actionPath, context);
      if (iteration.status !== 'Succeeded') status = iteration.status;
      if (context.terminated) break;
    }
    context.currentItem = previousItem;
    context.loopItems[name] = previousLoopItem;
    return { status, output: { iterations: items.length } };
  }
  if (action.type === 'If') {
    const taken = Boolean(evaluateCondition(action.expression, context, actionPath));
    context.branches.push({ actionPath, taken });
    const branch = taken ? action.actions : action.else?.actions;
    const branchResult = executeCollection(branch ?? {}, taken ? actionPath : `${actionPath}/else`, context);
    return { status: branchResult.status, output: { taken } };
  }
  if (action.type === 'Scope') {
    const scopeResult = executeCollection(action.actions ?? {}, actionPath, context);
    return { status: scopeResult.status, output: { status: scopeResult.status } };
  }
  if (action.type === 'Terminate') {
    const inputs = evaluateValue(action.inputs ?? {}, context, actionPath);
    const status = inputs.runStatus;
    if (!['Succeeded', 'Failed'].includes(status)) fail(context, actionPath, `unsupported Terminate status ${status}`);
    context.terminal = { actionPath, status };
    context.terminated = true;
    return { status, output: inputs };
  }
  fail(context, actionPath, `unsupported action type ${action.type}`);
}

function executeCollection(actions, prefix, context) {
  const pending = new Map(Object.entries(actions ?? {}));
  const states = new Map();
  while (pending.size > 0) {
    let progressed = false;
    for (const [name, action] of [...pending.entries()]) {
      const actionPath = pathJoin(prefix, name);
      if (context.terminated) {
        states.set(name, 'Skipped');
        context.actions.push({ path: actionPath, type: action.type, status: 'Skipped' });
        pending.delete(name);
        progressed = true;
        continue;
      }
      const dependencies = Object.entries(action.runAfter ?? {});
      if (dependencies.some(([dependency]) => !states.has(dependency))) continue;
      const eligible = dependencies.every(([dependency, statuses]) => statuses.includes(states.get(dependency)));
      if (!eligible) {
        states.set(name, 'Skipped');
        context.actions.push({ path: actionPath, type: action.type, status: 'Skipped' });
        pending.delete(name);
        progressed = true;
        continue;
      }
      const outcome = executeAction(name, action, actionPath, context);
      states.set(name, outcome.status);
      context.outputs[name] = outcome.output;
      context.actions.push({ path: actionPath, type: action.type, status: outcome.status });
      pending.delete(name);
      progressed = true;
    }
    if (!progressed) {
      const [name] = pending.keys();
      fail(context, pathJoin(prefix, name), 'runAfter dependency cycle prevented execution');
    }
  }
  const statuses = [...states.values()];
  if (statuses.includes('Failed')) return { status: 'Failed' };
  if (statuses.includes('TimedOut')) return { status: 'TimedOut' };
  return { status: 'Succeeded' };
}

function validateTrigger(name, trigger, context) {
  const actionPath = `trigger.${name}`;
  if (!SUPPORTED_TRIGGERS.has(trigger.type)) fail(context, actionPath, `unsupported trigger type ${trigger.type}`);
  validateExpressionFunctions(trigger, context, actionPath);
  if (trigger.type === 'OpenApiConnection') connectionKeyForHost(trigger.inputs?.host, context, actionPath);
  if (trigger.type === 'Request') {
    const required = trigger.inputs?.schema?.required ?? [];
    for (const key of required) {
      if (!Object.hasOwn(context.triggerInput, key)) fail(context, actionPath, `fixture triggerInput is missing ${key}`);
    }
  }
}

export function executeFlowDefinition({
  slug,
  definition,
  definitionPath = `flows/${slug}/definition.json`,
  fixture,
  apisMap,
  connectionsMap,
  connectorAdapter,
}) {
  const workflow = definition?.properties?.definition;
  const context = {
    flow: slug,
    definitionPath,
    fixture,
    apisMap: apisMap ?? {},
    connectionsMap: connectionsMap ?? {},
    connectionReferences: definition?.properties?.connectionReferences ?? {},
    connectorAdapter,
    triggerInput: fixture?.triggerInput,
    deterministicNow: fixture?.deterministicNow ?? fixture?.triggerInput?.deterministicNow ?? '2026-01-15T12:00:00Z',
    parameters: {
      '$authentication': fixture?.parameters?.['$authentication'] ?? {},
      '$connections': fixture?.parameters?.['$connections'] ?? {},
    },
    variables: {},
    outputs: {},
    loopItems: {},
    currentItem: null,
    actions: [],
    connectorCalls: [],
    branches: [],
    terminal: null,
    terminated: false,
  };
  if (!workflow || typeof workflow !== 'object') fail(context, '<definition>', 'properties.definition is missing');
  if (fixture?.flowSlug !== slug) fail(context, 'fixture.flowSlug', `expected ${slug}`);
  if (fixture?.mode !== 'local-mock') fail(context, 'fixture.mode', 'fixture mode must be local-mock');
  if (fixture?.tenantCalls !== 0) fail(context, 'fixture.tenantCalls', 'fixture tenantCalls must be zero');
  if (!fixture?.triggerInput || typeof fixture.triggerInput !== 'object') fail(context, 'fixture.triggerInput', 'fixture triggerInput must be an object');
  const triggers = Object.entries(workflow.triggers ?? {});
  if (triggers.length !== 1) fail(context, '<triggers>', 'exactly one trigger is required');
  validateTrigger(triggers[0][0], triggers[0][1], context);
  validateCollection(workflow.actions ?? {}, '', context);
  const execution = executeCollection(workflow.actions ?? {}, '', context);
  const status = context.terminal?.status ?? execution.status;
  const tenantCalls = context.connectorCalls.filter(({ transport }) => transport === 'tenant').length;
  return {
    flow: slug,
    status,
    triggerCount: triggers.length,
    trigger: { name: triggers[0][0], type: triggers[0][1].type, input: structuredClone(context.triggerInput) },
    triggerTypes: triggers.map(([, trigger]) => trigger.type),
    definitionActionCount: countActions(workflow.actions),
    definitionBranchCount: countActionsOfType(workflow.actions, 'If'),
    definitionExpressionCount: countExpressions(workflow),
    actions: context.actions,
    branches: context.branches,
    connectorCalls: context.connectorCalls,
    outputs: context.outputs,
    variables: context.variables,
    tenantCalls,
    handoff: {
      status,
      terminal: context.terminal,
      connectorCallCount: context.connectorCalls.length,
      executedActionCount: context.actions.filter(({ status: actionStatus }) => actionStatus !== 'Skipped').length,
    },
  };
}
