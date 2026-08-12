import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const index = JSON.parse(readFileSync(path.join(root, 'flows', 'flow-index.json'), 'utf8'));
const expectedActionCounts = new Map([
  ['bootstrap-lists', 6],
  ['add-columns-and-views', 9],
  ['user-access-matrix', 28],
  ['seed-cases-01', 7],
  ['seed-cases-02', 7],
  ['seed-vendors-01', 7],
  ['seed-vendors-02', 7],
  ['manual-move-trigger-test', 2],
  ['ingest-queue-west', 11],
  ['ingest-queue-north', 11],
  ['ingest-queue-east', 11],
  ['ingest-queue-south', 11],
]);

let runner;
let importFailure;
try {
  runner = await import('../../tools/flow-definition-runner.mjs');
} catch (error) {
  importFailure = error;
}

const clone = (value) => structuredClone(value);
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));

function loadFlow(slug) {
  const flow = index.flows.find((entry) => entry.slug === slug);
  assert.ok(flow, `flow index contains ${slug}`);
  const directory = path.posix.dirname(flow.definition);
  return {
    slug,
    definitionPath: flow.definition,
    definition: readJson(flow.definition),
    fixture: readJson(`fixtures/flow-runs/${slug}.json`),
    apisMap: readJson(`${directory}/apis-map.json`),
    connectionsMap: readJson(`${directory}/connections-map.json`),
  };
}

function execute(flow) {
  return runner.executeFlowDefinition(flow);
}

function executeIngestAt(deterministicNow, expression) {
  const flow = loadFlow('ingest-queue-west');
  flow.fixture = { ...flow.fixture, deterministicNow };
  if (expression) {
    flow.definition = clone(flow.definition);
    flow.definition.properties.definition.actions.Within_UK_weekday_window.expression = expression;
  }
  return execute(flow);
}

function windowTakenAt(deterministicNow) {
  return executeIngestAt(deterministicNow).branches
    .find(({ actionPath }) => actionPath === 'Within_UK_weekday_window')?.taken;
}

test('independent definition runner API is executable', () => {
  assert.equal(importFailure, undefined, importFailure?.message);
  assert.equal(typeof runner?.executeFlowDefinition, 'function');
  assert.equal(typeof runner?.FlowExecutionError, 'function');
});

test('all 12 readable definitions execute from their fixtures without index contracts', () => {
  assert.equal(typeof runner?.executeFlowDefinition, 'function');
  const results = index.flows.map(({ slug }) => execute(loadFlow(slug)));
  assert.equal(results.length, 12);
  for (const result of results) {
    assert.equal(result.triggerCount, 1, `${result.flow}: trigger count`);
    assert.equal(result.definitionActionCount, expectedActionCounts.get(result.flow), `${result.flow}: definition action count`);
    assert.equal(result.status, 'Succeeded', `${result.flow}: status`);
    assert.equal(result.tenantCalls, 0, `${result.flow}: tenant calls`);
    assert.equal(result.handoff.status, 'Succeeded', `${result.flow}: handoff status`);
  }
});

test('manual trigger traverses Compose and Terminate and exposes evaluated handoff output', () => {
  const result = execute(loadFlow('manual-move-trigger-test'));
  assert.deepEqual(result.actions.map(({ path: actionPath, status }) => [actionPath, status]), [
    ['Compose_MOVE_TRIGGER_TEST_RECEIVED', 'Succeeded'],
    ['Terminate_succeeded', 'Succeeded'],
  ]);
  assert.equal(result.outputs.Compose_MOVE_TRIGGER_TEST_RECEIVED, 'MOVE_TRIGGER_TEST_RECEIVED');
  assert.deepEqual(result.handoff.terminal, { actionPath: 'Terminate_succeeded', status: 'Succeeded' });
});

test('unsupported action fails with the definition file and exact action path', () => {
  const flow = loadFlow('manual-move-trigger-test');
  flow.definition = clone(flow.definition);
  flow.definition.properties.definition.actions.Compose_MOVE_TRIGGER_TEST_RECEIVED.type = 'UnsupportedFixtureAction';
  assert.throws(() => execute(flow), (error) => {
    assert.equal(error instanceof runner.FlowExecutionError, true);
    assert.equal(error.flow, 'manual-move-trigger-test');
    assert.equal(error.actionPath, 'Compose_MOVE_TRIGGER_TEST_RECEIVED');
    assert.match(error.message, /UnsupportedFixtureAction/);
    assert.match(error.message, /flows\/manual-move-trigger-test\/definition\.json/);
    return true;
  });
});

test('unsupported expression fails at the action that consumes it', () => {
  const flow = loadFlow('ingest-queue-west');
  flow.definition = clone(flow.definition);
  flow.definition.properties.definition.actions.Within_UK_weekday_window.expression = '@unsupportedFixtureFunction(1)';
  assert.throws(() => execute(flow), (error) => {
    assert.equal(error.actionPath, 'Within_UK_weekday_window');
    assert.match(error.message, /unsupportedFixtureFunction/);
    return true;
  });
});

test('dangling runAfter fails at the dependent action', () => {
  const flow = loadFlow('manual-move-trigger-test');
  flow.definition = clone(flow.definition);
  flow.definition.properties.definition.actions.Terminate_succeeded.runAfter = { Missing_Action: ['Succeeded'] };
  assert.throws(() => execute(flow), (error) => {
    assert.equal(error.actionPath, 'Terminate_succeeded');
    assert.match(error.message, /Missing_Action/);
    return true;
  });
});

test('missing connection mapping fails at the connected trigger', () => {
  const flow = loadFlow('manual-move-trigger-test');
  flow.connectionsMap = {};
  assert.throws(() => execute(flow), (error) => {
    assert.equal(error.actionPath, 'trigger.When_a_new_email_arrives_in_a_shared_mailbox_(V2)');
    assert.match(error.message, /shared_office365-1/);
    return true;
  });
});

test('fixture mutation fails before execution', () => {
  const flow = loadFlow('manual-move-trigger-test');
  flow.fixture = { ...flow.fixture, mode: 'tenant-live' };
  assert.throws(() => execute(flow), (error) => {
    assert.equal(error.actionPath, 'fixture.mode');
    assert.match(error.message, /local-mock/);
    return true;
  });
});

test('explicit retry policy consumes a failed then successful fixture attempt', () => {
  const flow = loadFlow('ingest-queue-west');
  flow.definition = clone(flow.definition);
  const getEmails = flow.definition.properties.definition.actions.Within_UK_weekday_window.actions['Get_emails_(V3)'];
  getEmails.runtimeConfiguration = { retryPolicy: { type: 'fixed', count: 1 } };
  flow.fixture = clone(flow.fixture);
  flow.fixture.connectorResponses = {
    'Within_UK_weekday_window/Get_emails_(V3)': {
      attempts: [
        { status: 'Failed', error: { code: 'TRANSIENT_FIXTURE' } },
        { status: 'Succeeded', outputs: { statusCode: 200, body: { value: [] } } },
      ],
    },
  };
  const result = execute(flow);
  const call = result.connectorCalls.find(({ actionPath }) => actionPath === 'Within_UK_weekday_window/Get_emails_(V3)');
  assert.equal(call.status, 'Succeeded');
  assert.equal(call.attempts, 2);
});

test('connector execution fails closed when its exact fixture is missing', () => {
  const flow = loadFlow('ingest-queue-west');
  flow.fixture = clone(flow.fixture);
  flow.fixture.connectorResponses = {};
  assert.throws(() => execute(flow), (error) => {
    assert.equal(error.actionPath, 'Within_UK_weekday_window/Get_emails_(V3)');
    assert.match(error.message, /explicit connector fixture/i);
    return true;
  });
});

test('connector execution rejects wildcard success fixtures', () => {
  const flow = loadFlow('ingest-queue-west');
  flow.fixture = clone(flow.fixture);
  flow.fixture.connectorResponses = {
    '*': { attempts: [{ status: 'Succeeded', outputs: { statusCode: 200, body: { value: [] } } }] },
  };
  assert.throws(() => execute(flow), /wildcard connector fixtures are prohibited/i);
});

test('failed access scope follows failed runAfter compensation and failed handoff', () => {
  const flow = loadFlow('user-access-matrix');
  flow.fixture = clone(flow.fixture);
  flow.fixture.connectorResponses = {
    ...flow.fixture.connectorResponses,
    'Apply_access_changes/Apply_to_each_role_assignment/Add_role_assignment': {
      attempts: [{ status: 'Failed', error: { code: 'ACCESS_FIXTURE_FAILURE' } }],
    },
  };
  const result = execute(flow);
  assert.equal(result.status, 'Failed');
  assert.equal(result.actions.some(({ path: actionPath, status }) => actionPath === 'Compensate_reset_inheritance' && status === 'Succeeded'), true);
  assert.deepEqual(result.handoff.terminal, { actionPath: 'Terminate_after_compensation', status: 'Failed' });
});

test('ingest fixture evaluates branch expressions, connector inputs and outputs', () => {
  const result = execute(loadFlow('ingest-queue-west'));
  assert.equal(result.branches.find(({ actionPath }) => actionPath === 'Within_UK_weekday_window')?.taken, true);
  assert.equal(result.branches.find(({ actionPath }) => actionPath.endsWith('/Condition'))?.taken, true);
  assert.equal(result.branches.find(({ actionPath }) => actionPath.endsWith('/Condition_1'))?.taken, false);
  const addRow = result.connectorCalls.find(({ actionPath }) => actionPath.endsWith('/Add_a_row_into_a_table'));
  assert.equal(addRow.inputs.parameters['item/UniqueKey'], '<fixture-ingest-west-0001@example.invalid>');
  assert.equal(addRow.outputs.body.rowId, 'ROW-WEST-0001');
});

test('UK weekday window uses GMT boundaries in January', () => {
  assert.equal(windowTakenAt('2026-01-15T07:29:00Z'), false);
  assert.equal(windowTakenAt('2026-01-15T07:30:00Z'), true);
  assert.equal(windowTakenAt('2026-01-15T16:30:00Z'), true);
  assert.equal(windowTakenAt('2026-01-15T16:31:00Z'), false);
  assert.equal(windowTakenAt('2026-01-17T12:00:00Z'), false);
});

test('UK weekday window uses BST boundaries in July without a fixed offset', () => {
  assert.equal(windowTakenAt('2026-07-15T06:29:00Z'), false);
  assert.equal(windowTakenAt('2026-07-15T06:30:00Z'), true);
  assert.equal(windowTakenAt('2026-07-15T15:30:00Z'), true);
  assert.equal(windowTakenAt('2026-07-15T15:31:00Z'), false);
});

test('Europe London conversion is deterministic across March and October transitions', () => {
  const equalsLocalTime = (hhmm) => `@equals(formatDateTime(convertTimeZone(utcNow(),'UTC','GMT Standard Time'),'HHmm'),'${hhmm}')`;
  assert.equal(executeIngestAt('2026-03-29T00:59:00Z', equalsLocalTime('0059')).branches[0].taken, true);
  assert.equal(executeIngestAt('2026-03-29T01:00:00Z', equalsLocalTime('0200')).branches[0].taken, true);
  assert.equal(executeIngestAt('2026-10-25T00:59:00Z', equalsLocalTime('0159')).branches[0].taken, true);
  assert.equal(executeIngestAt('2026-10-25T01:00:00Z', equalsLocalTime('0100')).branches[0].taken, true);
});

test('timezone conversion fails closed for invalid timestamps and unsupported zones', () => {
  assert.throws(
    () => executeIngestAt('not-a-date', `@equals(formatDateTime(convertTimeZone(utcNow(),'UTC','GMT Standard Time'),'HHmm'),'0000')`),
    /invalid date-time/i,
  );
  assert.throws(
    () => executeIngestAt('2026-01-15T12:00:00Z', `@equals(formatDateTime(convertTimeZone(utcNow(),'UTC','Fixture Zone'),'HHmm'),'1200')`),
    /unsupported time zone/i,
  );
});
