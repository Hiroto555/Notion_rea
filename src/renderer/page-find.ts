export function pageFindLabel(total: number, index: number): string {
  if (total <= 0) return "0 件";
  if (index < 0 || index >= total) return `${total} 件`;
  return `${index + 1} / ${total} 件`;
}

export function stepPageFind(
  index: number,
  total: number,
  direction: 1 | -1,
): number {
  if (total <= 0) return -1;
  if (index < 0 || index >= total) return direction > 0 ? 0 : total - 1;
  return (index + direction + total) % total;
}

export function revealPageFindIndex(index: number, total: number): number {
  if (total <= 0) return -1;
  if (index < 0 || index >= total) return 0;
  return index;
}
