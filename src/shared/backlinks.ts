export type BacklinkOccurrence = {
  blockId: string | null; context: string; linkText: string;
  ranges: {start: number; end: number}[];
};
export type BacklinkGroup = {
  pageId: string; title: string; icon: string; occurrences: BacklinkOccurrence[];
};
