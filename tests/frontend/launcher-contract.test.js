import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.DEMO_HANDOFF_ROOT
  ? path.resolve(process.env.DEMO_HANDOFF_ROOT)
  : path.resolve(import.meta.dirname, '..', '..');
const launcherPath = path.join(root, 'frontend', 'launcher', 'escalation-launcher.js');
const LIVE_SPACED_FIELDS = {
  SourceQueue: 'Source_x0020_Queue',
  ReceivedDateTime: 'Received_x0020_Date_x0020_Time',
  InternetMessageId: 'Internet_x0020_Message_x0020_ID',
  OutlookMessageId: 'Outlook_x0020_Message_x0020_ID',
  ConversationId: 'Conversation_x0020_ID',
  OriginalUniqueKey: 'Original_x0020_UniqueKey',
  VendorName: 'Vendor_x0020_Name',
  VendorCategory: 'Vendor_x0020_Category',
  DocDate: 'Doc_x0020_Date',
  InvRef: 'Inv_x0020_Ref',
  ActionType: 'Action_x0020_Type',
  APOwner: 'AP_x0020_Owner',
  EscalationDate: 'Escalation_x0020_Date',
  WorkingNotes: 'Working_x0020_Notes',
  DateResolved: 'Date_x0020_Resolved',
  DaysToResolve: 'Days_x0020_To_x0020_Resolve',
  IsClosed: 'Is_x0020_Closed',
};

test('Escalation launcher derives its hosted asset root from the injected script URL', () => {
  const source = readFileSync(launcherPath, 'utf8');
  assert.match(source, /document\.currentScript/);
  assert.match(source, /new URL\(['"]\.['"],\s*injectedScript\.src\)/);
  assert.match(source, /assets\/app\.js/);
  assert.match(source, /credentials:\s*['"]include['"]/);
});

test('Escalation launcher injects a coherent current runtime config before loading the bundle', () => {
  const source = readFileSync(launcherPath, 'utf8');
  assert.match(source, /window\.DEMO_ESCALATION_CONFIG\s*=/);
  assert.match(source, /status:\s*["'][A-Z_]+["']/);
  assert.match(source, /mode:\s*["']sharepoint["']/);
  assert.match(source, /verified:\s*(?:true|false)/);
  assert.doesNotMatch(source, /mode:\s*["']mock["']/i);
  assert.match(source, /createElement\(['"]script['"]\)/);
});

test('Escalation launcher has no blocked donor identifiers or shared-link tokens', () => {
  const source = readFileSync(launcherPath, 'utf8');
  const blocked = [
    'AP_' + 'Tracker',
    'AP' + 'Tracker',
    'EXOZivVa4IJHqTJuh29uSLkB_AyRO2y9afBXxZB4RdyYaY',
  ];
  for (const marker of blocked) {
    assert.equal(source.toLowerCase().includes(marker.toLowerCase()), false, marker);
  }
});

test('Escalation launcher maps every spaced UI field to the confirmed live EntityPropertyName', () => {
  const source = readFileSync(launcherPath, 'utf8');
  for (const [logicalName, entityPropertyName] of Object.entries(LIVE_SPACED_FIELDS)) {
    assert.match(
      source,
      new RegExp(`${logicalName}:\\s*["']${entityPropertyName}["']`),
      `${logicalName} live mapping`,
    );
  }
  assert.doesNotMatch(source, /SourceQueue:\s*["']SourceQueue["']/);
});
