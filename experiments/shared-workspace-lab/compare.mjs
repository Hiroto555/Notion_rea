import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { runEngineScenario as engineB } from './src/engine-b.mjs';
import { runEngineScenario as engineC } from './src/engine-c.mjs';
import { fixtureDoc } from './src/schema.mjs';
import { canonicalJson, hashJson } from './src/contracts.mjs';

function random(seed) {
  let state = seed;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}
function paragraphText(doc) { return (doc.content[1].content ?? []).map(node => node.text ?? '').join(''); }

/** Same intent schedule, distinct real engines. Finite text-insert evidence only. */
export function compareCases({ seedCount = 16, operationsPerSeed = 8 } = {}) {
  if (!Number.isSafeInteger(seedCount) || seedCount < 1 || seedCount > 128 ||
      !Number.isSafeInteger(operationsPerSeed) || operationsPerSeed < 2 || operationsPerSeed > 100) {
    throw new TypeError('invalid comparison bounds');
  }
  const cases = [];
  for (let seed = 1; seed <= seedCount; seed++) {
    const next = random(seed);
    const operations = Array.from({ length: operationsPerSeed }, (_, index) => ({
      clientId: index % 2 ? 'b' : 'a', blockId: 'p1', offset: next() % 7, text: index % 2 ? 'B' : 'A',
    }));
    for (const [engine, run] of [['B', engineB], ['C', engineC]]) {
      const doc = fixtureDoc();
      const before = canonicalJson({ doc, operations });
      const start = performance.now();
      const result = run({ doc, operations });
      const milliseconds = performance.now() - start;
      if (!result.converged || result.documents.length !== 2 ||
          canonicalJson(result.documents[0]) !== canonicalJson(result.documents[1])) throw new Error(`${engine}: convergence failed`);
      if (engine === 'C' && (!result.serverDocument || canonicalJson(result.serverDocument) !== canonicalJson(result.documents[0]))) {
        throw new Error('C: server and client projections differ');
      }
      for (const projected of result.documents) {
        const text = paragraphText(projected);
        if ((text.match(/A/g) ?? []).length !== Math.ceil(operationsPerSeed / 2) ||
            (text.match(/B/g) ?? []).length !== Math.floor(operationsPerSeed / 2) ||
            text.replace(/[AB]/g, '') !== 'abcdef') throw new Error(`${engine}: accepted intent lost or duplicated`);
        if (canonicalJson(projected.content[2]) !== canonicalJson(doc.content[2])) throw new Error(`${engine}: untouched table changed`);
        if (canonicalJson(projected.content[0]) !== canonicalJson(doc.content[0])) throw new Error(`${engine}: untouched heading changed`);
        const retainedMarkedText = (projected.content[1].content ?? [])
          .filter(node => (node.marks ?? []).some(mark => mark.type === 'strong'))
          .map(node => (node.text ?? '').replace(/[AB]/g, '')).join('');
        if (retainedMarkedText !== 'abcdef') throw new Error(`${engine}: original marks changed`);
        if (projected.content[1].attrs.blockId !== 'p1') throw new Error(`${engine}: identity changed`);
      }
      if (before !== canonicalJson({ doc, operations })) throw new Error(`${engine}: input mutated`);
      cases.push({ seed, engine, operationCount: operations.length, scheduleHash: hashJson(operations),
        projectionHash: hashJson(result.documents[0]), traceEvents: result.trace.length,
        milliseconds: Number(milliseconds.toFixed(3)), result: 'PASS_IN_RESTRICTED_SCOPE' });
    }
  }
  return { scope: 'restricted-schema-text-insert', cases,
    engineAdoption: 'UNDECIDED', productAcceptance: 'NOT_RUN',
    notCovered: ['table structural concurrency', 'local Undo', 'IME', 'real network partition',
      'server durability of either engine', 'causal hidden roots', 'physical devices', 'full V01-V05 or L5 gates'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(compareCases(), null, 2));
}
