import type { DatabaseData, RecordRow } from "../shared/types";
export function queryRows(db: DatabaseData): RecordRow[] {
  const q = db.filter.trim().toLocaleLowerCase();
  const rows = db.rows.filter((r) =>
    [r.title, ...Object.values(r.values)]
      .join(" ")
      .toLocaleLowerCase()
      .includes(q),
  );
  if (db.sort) {
    const desc = db.sort.startsWith("-"),
      key = desc ? db.sort.slice(1) : db.sort;
    rows.sort((a, b) => {
      const x = key === "title" ? a.title : (a.values[key] ?? ""),
        y = key === "title" ? b.title : (b.values[key] ?? "");
      return (
        (typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "ja", { numeric: true })) *
        (desc ? -1 : 1)
      );
    });
  }
  return rows;
}
export function monthDays(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(y, m - 1, 1, 12);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
}
