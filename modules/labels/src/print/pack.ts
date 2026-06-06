// Server-side mirror of web/src/lib/labelPack.ts — keep the algorithm
// in lockstep with the browser preview so what the user sees matches
// what comes out of the printer. See that file for the design notes.

export interface PackableItem {
  w: number;
  h: number;
}

export interface Placement<T extends PackableItem> {
  item: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sheet<T extends PackableItem> {
  placements: Placement<T>[];
}

export function packShelves<T extends PackableItem>(
  items: T[],
  sheetW: number,
  sheetH: number,
): Sheet<T>[] {
  const sheets: Sheet<T>[] = [];
  let current: Sheet<T> = { placements: [] };
  let cursorX = 0;
  let shelfY = 0;
  let shelfH = 0;

  function pushCurrent() {
    if (current.placements.length > 0) sheets.push(current);
    current = { placements: [] };
    cursorX = 0;
    shelfY = 0;
    shelfH = 0;
  }

  for (const it of items) {
    if (it.w > sheetW || it.h > sheetH) {
      pushCurrent();
      current.placements.push({ item: it, x: 0, y: 0, w: it.w, h: it.h });
      pushCurrent();
      continue;
    }
    if (cursorX + it.w > sheetW + 1e-6) {
      shelfY += shelfH;
      cursorX = 0;
      shelfH = 0;
    }
    if (shelfY + it.h > sheetH + 1e-6) {
      pushCurrent();
    }
    current.placements.push({ item: it, x: cursorX, y: shelfY, w: it.w, h: it.h });
    cursorX += it.w;
    shelfH = Math.max(shelfH, it.h);
  }
  if (current.placements.length > 0) sheets.push(current);
  return sheets;
}

export function packShelvesBigFirst<T extends PackableItem>(
  items: T[],
  sheetW: number,
  sheetH: number,
): Sheet<T>[] {
  const sorted = [...items].sort((a, b) => b.w * b.h - a.w * a.h);
  return packShelves(sorted, sheetW, sheetH);
}
