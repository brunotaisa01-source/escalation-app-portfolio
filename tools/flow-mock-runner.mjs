import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeFlowDefinition, FlowExecutionError } from './flow-definition-runner.mjs';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

function validateExpectedExecution(flow, fixture, execution) {
  const expected = fixture.expected ?? {};
  if (expected.status && execution.status !== expected.status) {
    throw new FlowExecutionError({
      flow: flow.slug,
      definitionPath: flow.definition,
      actionPath: 'fixture.expected.status',
      reason: `expected ${expected.status}, received ${execution.status}`,
    });
  }
  for (const actionName of expected.requiredActions ?? []) {
    const record = execution.actions.find(({ path: actionPath, status }) => actionPath.split('/').at(-1) === actionName && status !== 'Skipped');
    if (!record) {
      throw new FlowExecutionError({
        flow: flow.slug,
        definitionPath: flow.definition,
        actionPath: 'fixture.expected.requiredActions',
        reason: `required action ${actionName} did not execute`,
      });
    }
  }
}

export function runLocalMock({
  root = moduleRoot,
  index = readJson(root, 'flows/flow-index.json'),
  definitionOverrides = new Map(),
  fixtureTransform,
  connectorAdapter,
} = {}) {
  return index.flows.map((flow) => {
    const flowDirectory = path.posix.dirname(flow.definition);
    const sourceFixture = readJson(root, `fixtures/flow-runs/${flow.slug}.json`);
    const fixture = fixtureTransform ? fixtureTransform(flow, structuredClone(sourceFixture)) : sourceFixture;
    const definition = definitionOverrides.get?.(flow.slug) ?? readJson(root, flow.definition);
    const execution = executeFlowDefinition({
      slug: flow.slug,
      definitionPath: flow.definition,
      definition,
      fixture,
      apisMap: readJson(root, `${flowDirectory}/apis-map.json`),
      connectionsMap: readJson(root, `${flowDirectory}/connections-map.json`),
      connectorAdapter,
    });
    validateExpectedExecution(flow, fixture, execution);
    const result = {
      flow: flow.slug,
      status: 'LOCAL_MOCK_GREEN',
      validationMode: 'definition-execution',
      executionStatus: execution.status,
      triggerCount: execution.triggerCount,
      triggerTypes: execution.triggerTypes,
      actionCount: execution.definitionActionCount,
      executedActionCount: execution.handoff.executedActionCount,
      branchCount: execution.definitionBranchCount,
      expressionCount: execution.definitionExpressionCount,
      connectorCallCount: execution.connectorCalls.length,
      connectorCalls: execution.connectorCalls,
      actions: execution.actions,
      branches: execution.branches,
      outputs: execution.outputs,
      handoff: execution.handoff,
      tenantCalls: execution.tenantCalls,
      externalGates: flow.externalGates,
    };
    connectorAdapter?.onFlowComplete?.(structuredClone(result));
    return result;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify({ mode: 'local-definition-execution', results: runLocalMock() }, null, 2)}\n`);
}
