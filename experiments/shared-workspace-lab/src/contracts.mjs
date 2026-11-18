import { createHash } from 'node:crypto';
export const LAB_PROTOCOL = 'folio-shared-lab/1';
export const isId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
export function assertUnicodeText(text) {
 if (typeof text !== 'string' || !text.isWellFormed()) throw new TypeError('unsupported Unicode');
}
export function canonicalJson(value) {
 const seen = new Set();
 function visit(v) {
  if(v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if(typeof v === 'number') { if(!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))) throw new TypeError('unsupported number'); return JSON.stringify(v); }
  if(typeof v !== 'object' || seen.has(v)) throw new TypeError('unsupported JSON');
  if(!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new TypeError('unsupported object');
  if (Object.getOwnPropertySymbols(v).length) throw new TypeError('unsupported symbol key');
  const descriptors = Object.getOwnPropertyDescriptors(v);
  for (const [key, descriptor] of Object.entries(descriptors)) {
   if (Array.isArray(v) && key === 'length') continue;
   if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('unsupported property');
   if (Array.isArray(v) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) throw new TypeError('unsupported array property');
  }
  if (Array.isArray(v)) {
   for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i)) throw new TypeError('sparse array');
  }
  seen.add(v); const out=Array.isArray(v)?'['+v.map(visit).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+visit(v[k])).join(',')+'}';seen.delete(v);return out;
 }
 return visit(value);
}
export function cloneJson(value) { return JSON.parse(canonicalJson(value)); }
export function hashJson(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function invalid(code='INVALID') { return {ok:false,code}; }
