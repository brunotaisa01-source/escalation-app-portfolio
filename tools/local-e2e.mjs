import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEscalationQuery } from '../frontend/src/services/sharepoint-query.js';
import { buildEscalationCsv } from '../frontend/src/services/csv-export.js';
import { runLocalMock } from './flow-mock-runner.mjs';
import { createFakeConnector } from '../runtime/fake-connector.mjs';

export async function runLocalE2E({
  writeOutputs = false,
  outputRoot,
  deterministicNow = '2026-01-15T12:00:00Z',
  clock = () => new Date(),
  includeCsv = false,
  definitionOverrides = new Map(),
} = {}) {
  const observedDate = clock();
  if (!(observedDate instanceof Date) || Number.isNaN(observedDate.getTime())) throw new TypeError('clock must return a valid Date');
  const deterministicDate = new Date(deterministicNow);
  if (Number.isNaN(deterministicDate.getTime())) throw new TypeError('deterministicNow must be a valid date-time');
  const connector = createFakeConnector();
  const connectorAdapter = connector.flowAdapter();
  const flowResults = runLocalMock({
    definitionOverrides,
    connectorAdapter,
    fixtureTransform(flow, fixture) {
      if (flow.slug.startsWith('seed-cases-') || flow.slug.startsWith('seed-vendors-')) fixture.triggerInput.dryRun = false;
      return fixture;
    },
  });

  const snapshot = connector.snapshot();
  const dashboard = connector.dashboard({ status: 'All', pageSize: 10 });
  const openPage = connector.queryCases({ status: 'Open', page: 1, pageSize: 10 });
  const exportRows = connector.exportCases({ status: 'All' });
  const query = buildEscalationQuery({ status: 'Open', pageSize: 10 }).toString();
  const csv = buildEscalationCsv(exportRows, { now: deterministicDate });
  const csvSha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
  const tenantCalls = flowResults.reduce((total, flow) => total + flow.tenantCalls, 0);
  const sequence = [
    ...snapshot.flowExecutions.map(({ flow }) => flow),
    'dashboard-query',
    'open-query',
    'csv-export',
    'handoff-output',
  ];
  const result = {
    schemaVersion: '1.0.0', mode: 'local-e2e-mock', deterministicNow: deterministicDate.toISOString(), observedWallClock: observedDate.toISOString(), tenantCalls,
    sequence,
    steps: snapshot.flowExecutions,
    flowResults,
    storage: {
      listNames: Object.keys(snapshot.lists),
      cases: snapshot.lists['Demo Escalations'].items.length,
      vendors: snapshot.lists['Demo Vendor Reference'].items.length,
      etlRows: snapshot.etlRows.length,
      connectorEffects: snapshot.connectorEffects.length,
      flowExecutions: snapshot.flowExecutions.length,
      historyEntries: snapshot.history.length,
    },
    dashboard: { counts: dashboard.counts, total: dashboard.page.total, openTotal: openPage.total, firstCaseId: dashboard.page.items[0]?.id ?? null },
    query: { openQuery: query, returnedItems: openPage.items.length },
    handoff: {
      csvFile: 'local-export.csv',
      storageFile: 'local-storage-snapshot.json',
      outputLocation: writeOutputs ? 'caller-controlled-output-root' : 'not-written',
      rowCount: exportRows.length,
      utf8Bom: csv.charCodeAt(0) === 0xFEFF,
      csvSha256,
    },
    externalGates: { tenantImport: 'RED_EXTERNAL_GATE', tenantReadback: 'RED_EXTERNAL_GATE', authenticatedUat: 'RED_EXTERNAL_GATE' },
  };
  if (includeCsv) result.csv = csv;
  if (writeOutputs) {
    if (!outputRoot) throw new TypeError('outputRoot is required when writeOutputs is true');
    const evidence = path.resolve(outputRoot);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(path.join(evidence, 'local-handoff.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(evidence, 'local-storage-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(evidence, 'local-export.csv'), csv, 'utf8');
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runLocalE2E({ writeOutputs: Boolean(process.env.ESCALATION_E2E_OUTPUT_ROOT), outputRoot: process.env.ESCALATION_E2E_OUTPUT_ROOT });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
