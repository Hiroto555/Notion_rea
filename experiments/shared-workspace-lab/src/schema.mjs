import { Schema } from 'prosemirror-model';
import { canonicalJson, isId, assertUnicodeText } from './contracts.mjs';
// Restricted comparison fixture schema; NOT the complete Folio editor schema.
export const schema = new Schema({nodes:{doc:{content:'block+'},text:{group:'inline'},paragraph:{group:'block',content:'inline*',attrs:{blockId:{default:null}}},heading:{group:'block',content:'inline*',attrs:{blockId:{default:null},level:{default:1}}},table:{group:'block',content:'tableRow+',attrs:{blockId:{default:null}}},tableRow:{content:'tableCell+'},tableCell:{content:'block+'}},marks:{strong:{},link:{attrs:{href:{}}}}});
export function fixtureDoc(){return {type:'doc',content:[{type:'heading',attrs:{blockId:'h1',level:2},content:[{type:'text',text:'合成資料'}]},{type:'paragraph',attrs:{blockId:'p1'},content:[{type:'text',text:'abcdef',marks:[{type:'strong'}]}]},{type:'table',attrs:{blockId:'table1'},content:[{type:'tableRow',content:[{type:'tableCell',content:[{type:'paragraph',attrs:{blockId:'cell1'},content:[{type:'text',text:'セル'}]}]}]}]}]};}

/** Refuse information the restricted schema cannot retain; never repair IDs here. */
export function assertFixtureDocument(value) {
 canonicalJson(value);
 function unicode(v) {
  if (typeof v === 'string') assertUnicodeText(v);
  else if (v && typeof v === 'object') for (const key of Object.keys(v)) { assertUnicodeText(key); unicode(v[key]); }
 }
 unicode(value);
 const ids = new Set();
 function attributes(attrs, spec) {
  if (attrs == null) return;
  if (typeof attrs !== 'object' || Array.isArray(attrs)) throw new TypeError('invalid attributes');
  for (const key of Object.keys(attrs)) if (!Object.hasOwn(spec ?? {}, key)) throw new TypeError('unsupported attribute');
 }
 function visit(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(schema.nodes, node.type)) throw new TypeError('invalid node');
  for (const key of Object.keys(node)) if (!['type','attrs','content','marks','text'].includes(key)) throw new TypeError('unsupported node field');
  const spec = schema.nodes[node.type].spec;
  attributes(node.attrs, spec.attrs);
  if (spec.attrs && Object.hasOwn(spec.attrs, 'blockId')) {
   const id = node.attrs?.blockId;
   if (!isId(id) || ids.has(id)) throw new TypeError('missing or duplicate block ID');
   ids.add(id);
  }
  if (node.marks !== undefined) {
   if (!Array.isArray(node.marks)) throw new TypeError('invalid marks');
   for (const mark of node.marks) {
    if (!mark || typeof mark !== 'object' || !Object.hasOwn(schema.marks, mark.type)) throw new TypeError('invalid mark');
    for (const key of Object.keys(mark)) if (!['type','attrs'].includes(key)) throw new TypeError('unsupported mark field');
    attributes(mark.attrs, schema.marks[mark.type].spec.attrs);
   }
  }
  if (node.content !== undefined) {
   if (!Array.isArray(node.content) || node.type === 'text') throw new TypeError('invalid content');
   for (const child of node.content) visit(child);
  }
  if (node.type !== 'text' && node.text !== undefined) throw new TypeError('unsupported text field');
 }
 visit(value);
 const parsed = schema.nodeFromJSON(value);
 if (parsed.type !== schema.nodes.doc) throw new TypeError('invalid root');
 parsed.check();
 return parsed;
}
