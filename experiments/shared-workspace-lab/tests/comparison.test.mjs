import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCases } from '../compare.mjs';

test('both real engines receive identical schedules and preserve accepted intents', () => {
  const result = compareCases({ seedCount: 8, operationsPerSeed: 10 });
  assert.equal(result.cases.length, 16);
  assert.equal(result.engineAdoption, 'UNDECIDED');
  assert.equal(result.productAcceptance, 'NOT_RUN');
  for (let seed = 1; seed <= 8; seed++) {
    const pair = result.cases.filter(row => row.seed === seed);
    assert.deepEqual(pair.map(row => row.engine), ['B', 'C']);
    assert.equal(pair[0].scheduleHash, pair[1].scheduleHash);
    assert.ok(pair.every(row => row.result === 'PASS_IN_RESTRICTED_SCOPE' && row.traceEvents > 0));
  }
});

test('comparison bounds refuse unbounded or invalid work', () => {
  for (const options of [{ seedCount: 0 }, { seedCount: 129 }, { operationsPerSeed: 1 }, { operationsPerSeed: 101 }]) {
    assert.throws(() => compareCases(options), /bounds/);
  }
});
