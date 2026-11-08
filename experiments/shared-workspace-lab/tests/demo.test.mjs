import test from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../demo.mjs';

test('synthetic end-to-end lab exercise keeps scope and uncertainty explicit', { timeout: 10000 }, async () => {
  const result = await runDemo();
  assert.equal(result.result, 'PASS_IN_LAB_SCOPE');
  assert.equal(result.server.eventCount, 7);
  assert.equal(result.server.audit.ok, true);
  assert.equal(result.clientStage, 'server');
  assert.equal(result.engineAdoption, 'UNDECIDED');
  assert.equal(result.productAcceptance, 'NOT_RUN');
});
