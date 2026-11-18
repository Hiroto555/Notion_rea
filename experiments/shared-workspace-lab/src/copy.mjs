import { isId, invalid } from './contracts.mjs';

const MAX_PAGES = 10000;
const MAX_SELECTION = 1000;
const MAX_TITLE = 1000;
const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validatePage(page, seenIds) {
  if (!isRecord(page)) return false;
  if (!isId(page.id) || seenIds.has(page.id)) return false;
  if (typeof page.title !== 'string' || page.title.length > MAX_TITLE) return false;
  if (page.parentId !== null && !isId(page.parentId)) return false;
  if (!Array.isArray(page.links) || !Array.isArray(page.assets)) return false;

  for (const link of page.links) {
    if (!isRecord(link) || !isId(link.targetId)) return false;
    if (Object.prototype.hasOwnProperty.call(link, 'label') && typeof link.label !== 'string') return false;
  }

  const sizes = new Map();
  for (const asset of page.assets) {
    if (!isRecord(asset)) return false;
    if (typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) return false;
    if (typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size < 0) return false;
    const known = sizes.get(asset.sha256);
    if (known !== undefined && known !== asset.size) return false;
    sizes.set(asset.sha256, asset.size);
  }

  seenIds.add(page.id);
  return true;
}

function validatePages(pages) {
  if (!Array.isArray(pages) || pages.length > MAX_PAGES) return false;
  const seenIds = new Set();
  for (const page of pages) {
    if (!validatePage(page, seenIds)) return false;
  }
  return true;
}

function dedupAssets(assets) {
  const byHash = new Map();
  for (const asset of assets) {
    if (!byHash.has(asset.sha256)) byHash.set(asset.sha256, { sha256: asset.sha256, size: asset.size });
  }
  return [...byHash.values()];
}

export function planSharedCopy({ pages, selectedIds, targetSpaceId, idMap } = {}) {
  if (!validatePages(pages) || !isId(targetSpaceId)) return invalid('INVALID');

  if (!Array.isArray(selectedIds) || selectedIds.length === 0) return invalid('MISSING');
  if (selectedIds.length > MAX_SELECTION) return invalid('INVALID');

  const selected = new Set();
  for (const id of selectedIds) {
    if (!isId(id) || selected.has(id)) return invalid('INVALID');
    selected.add(id);
  }

  const pagesById = new Map();
  for (const page of pages) pagesById.set(page.id, page);

  for (const id of selectedIds) {
    if (!pagesById.has(id)) return invalid('MISSING');
  }

  if (!isRecord(idMap)) return invalid('MAPPING');

  const newIds = new Set();
  const sourceIds = new Set(pagesById.keys());
  for (const id of selectedIds) {
    if (!Object.prototype.hasOwnProperty.call(idMap, id)) return invalid('MAPPING');
    const newId = idMap[id];
    if (!isId(newId) || sourceIds.has(newId) || newIds.has(newId)) return invalid('MAPPING');
    newIds.add(newId);
  }

  let unresolvedLinkCount = 0;
  const outPages = selectedIds.map(id => {
    const page = pagesById.get(id);
    const links = [];
    for (const link of page.links) {
      if (selected.has(link.targetId)) {
        const mapped = { targetId: idMap[link.targetId] };
        if (Object.prototype.hasOwnProperty.call(link, 'label')) mapped.label = link.label;
        links.push(mapped);
      } else {
        unresolvedLinkCount++;
      }
    }
    const parentId = page.parentId !== null && selected.has(page.parentId)
      ? idMap[page.parentId]
      : null;
    return {
      id: idMap[id],
      title: page.title,
      parentId,
      links,
      assets: dedupAssets(page.assets)
    };
  });

  return {
    ok: true,
    plan: {
      targetSpaceId,
      pages: outPages,
      unresolvedLinkCount
    }
  };
}
