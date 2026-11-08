import { createHash } from 'node:crypto';
import { invalid } from './contracts.mjs';

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isBytes(value) {
 return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

export function validateAsset(input) {
 if (input === null || typeof input !== 'object') return invalid();
 const { bytes, sha256, expectedSize, maxBytes = 1048576 } = input;
 if (!isBytes(bytes)) return invalid();
 if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return invalid();
 if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) return invalid();
 if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return invalid();

 if (bytes.byteLength > maxBytes) return invalid('LIMIT');
 if (bytes.byteLength !== expectedSize) return invalid('SIZE');

 const copy = Buffer.from(bytes);
 const digest = createHash('sha256').update(copy).digest('hex');
 if (digest !== sha256) return invalid('HASH');

 return { ok: true, asset: { sha256, size: copy.length, bytes: copy } };
}
