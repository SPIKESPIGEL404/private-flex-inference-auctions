export type Phase = 'booting' | 'ready' | 'running' | 'waiting' | 'complete' | 'paused' | 'error';
export interface Buyer {
  id: string;
  number: number;
  task: string;
  budgetMicros: number;
  scenario: 'complete' | 'waiting' | 'limit';
  previewMicros: number;
  turns: number;
}
export interface BuyerStatus { phase: Phase; detail?: string }
export const money = (micros: number) => {
  const fraction = String(micros % 1e6).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `$${Math.floor(micros / 1e6)}.${fraction}`;
};
export function parseBudget(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 1e6 + Number(fraction.padEnd(6, '0'));
  return amount > 0 && amount <= 100e6 ? amount : null;
}
export const storageKey = 'private-market.playground.v1';
export function loadBuyers(): Buyer[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Array.isArray(saved) && saved.length <= 8 && saved.every(b =>
      typeof b.id === 'string' && /^[a-f0-9-]{36}$/.test(b.id) && typeof b.task === 'string' && b.task.length <= 2000 &&
      Number.isSafeInteger(b.number) && b.number > 0 && Number.isSafeInteger(b.budgetMicros) && b.budgetMicros > 0 && b.budgetMicros <= 100e6 &&
      Number.isSafeInteger(b.previewMicros) && b.previewMicros >= 0 && b.previewMicros <= b.budgetMicros &&
      Number.isSafeInteger(b.turns) && b.turns >= 0 && ['complete', 'waiting', 'limit'].includes(b.scenario)) &&
      new Set(saved.map(b => b.id)).size === saved.length && new Set(saved.map(b => b.number)).size === saved.length) return saved;
  } catch { /* Storage may be unavailable; a fresh local preview still works. */ }
  return [{ id: crypto.randomUUID(), number: 1, task: 'Explain confidential inference in three short sentences.',
    budgetMicros: 10000, scenario: 'complete', previewMicros: 0, turns: 0 }];
}

export const maxBuyers = 8;
export const sessionConfigKey = 'private-market.playground.session.v2';
export interface BrowserSession { buyers: Buyer[]; parked: Buyer[] }
function validBuyer(value: unknown): value is Buyer {
  if (!value || typeof value !== 'object') return false;
  const b = value as Buyer;
  return typeof b.id === 'string' && /^[a-f0-9-]{36}$/.test(b.id) &&
    typeof b.task === 'string' && b.task.trim().length > 0 && b.task.length <= 2000 &&
    Number.isSafeInteger(b.number) && b.number > 0 &&
    Number.isSafeInteger(b.budgetMicros) && b.budgetMicros > 0 && b.budgetMicros <= 100e6 &&
    Number.isSafeInteger(b.previewMicros) && b.previewMicros >= 0 && b.previewMicros <= b.budgetMicros &&
    Number.isSafeInteger(b.turns) && b.turns >= 0 && ['complete', 'waiting', 'limit'].includes(b.scenario);
}
export function loadBrowserSession(): BrowserSession {
  try {
    const value = JSON.parse(sessionStorage.getItem(sessionConfigKey) ?? 'null');
    if (value && Array.isArray(value.buyers) && Array.isArray(value.parked)) {
      const all = [...value.buyers, ...value.parked];
      if (value.buyers.length >= 1 && all.length <= maxBuyers && all.every(validBuyer) &&
        new Set(all.map(b => b.id)).size === all.length && new Set(all.map(b => b.number)).size === all.length) return value;
    }
  } catch { /* Keep the session usable when storage is unavailable. */ }
  // Preserve existing prototype configurations; leave the legacy data intact.
  const legacy = loadBuyers();
  return { buyers: legacy.length ? legacy : [{ id: crypto.randomUUID(), number: 1,
    task: 'Explain confidential inference in three short sentences.', budgetMicros: 10000,
    scenario: 'complete', previewMicros: 0, turns: 0 }], parked: [] };
}

export function resizeSession(session: BrowserSession, count: number): BrowserSession {
  if (!Number.isInteger(count) || count < 1 || count > maxBuyers || count === session.buyers.length) return session;
  if (count < session.buyers.length) return {
    buyers: session.buyers.slice(0, count), parked: [...session.buyers.slice(count), ...session.parked],
  };
  const restored = session.parked.slice(0, count - session.buyers.length);
  const next = [...session.buyers, ...restored];
  let number = Math.max(...session.buyers.map(b => b.number), ...session.parked.map(b => b.number));
  while (next.length < count) next.push({ ...session.buyers[0], id: crypto.randomUUID(), number: ++number, previewMicros: 0, turns: 0 });
  return { buyers: next, parked: session.parked.slice(restored.length) };
}

export interface PaneRect { left: number; top: number; width: number; height: number; rightEdge: boolean; bottomEdge: boolean }
// A flat array keeps React keys/runtimes stable while tmux-style rows retile.
export function tilePanes(count: number, width: number, height: number): PaneRect[] {
  if (count < 1) return [];
  const rows = Math.min(count, Math.max(1, Math.round(Math.sqrt(count * 1.6 / Math.max(.2, width / Math.max(1, height))))));
  const result: PaneRect[] = [];
  for (let row = 0; row < rows; row++) {
    const columns = Math.floor(count / rows) + (row < count % rows ? 1 : 0);
    for (let col = 0; col < columns; col++) result.push({ left: col / columns * 100, top: row / rows * 100,
      width: 100 / columns, height: 100 / rows, rightEdge: col === columns - 1, bottomEdge: row === rows - 1 });
  }
  return result;
}
