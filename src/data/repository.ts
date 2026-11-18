/**
 * 資料存取層。所有模板庫與站點資料都透過 Repository 介面存取，之後加上後端只要新增實作。
 *   - BundledRepository：讀取隨網站部署的 public/data/*.json（Service Worker 快取，離線可用）
 *   - LocalRepository：IndexedDB，模板管理頁的編輯草稿
 *   - RemoteRepository：預留給後端（本版只有介面）
 */
import {
  bundleSchema,
  parseWith,
  stationsFileSchema,
  templatePackSchema,
  type DataBundle,
  type StationsFile,
  type TemplatePack,
} from './schema.ts';

export interface TemplateRepository {
  loadPack(): Promise<TemplatePack>;
}

export interface StationRepository {
  loadStations(): Promise<StationsFile>;
}

/** 可寫入的 Repository（模板管理頁使用） */
export interface WritableRepository extends TemplateRepository, StationRepository {
  savePack(pack: TemplatePack): Promise<void>;
  saveStations(stations: StationsFile): Promise<void>;
  /** 是否已有草稿 */
  hasDraft(): Promise<boolean>;
  clear(): Promise<void>;
}

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`讀取 ${url} 失敗（HTTP ${r.status}）`);
  return r.json();
}

/** 隨網站部署的資料（public/data/） */
export class BundledRepository implements TemplateRepository, StationRepository {
  constructor(private readonly base: string = import.meta.env.BASE_URL) {}

  async loadPack(): Promise<TemplatePack> {
    return parseWith(
      templatePackSchema,
      await fetchJson(`${this.base}data/template-pack.json`),
      'template-pack.json',
    );
  }

  async loadStations(): Promise<StationsFile> {
    return parseWith(stationsFileSchema, await fetchJson(`${this.base}data/stations.json`), 'stations.json');
  }
}

// ---------------- IndexedDB ----------------

const DB_NAME = 'hear-broadcast';
const STORE = 'drafts';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('無法開啟 IndexedDB'));
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失敗'));
    });
  } finally {
    db.close();
  }
}

/** 模板管理頁的編輯草稿（IndexedDB）；沒有草稿時以 fallback（隨網站部署的資料）為起點 */
export class LocalRepository implements WritableRepository {
  constructor(private readonly fallback: TemplateRepository & StationRepository = new BundledRepository()) {}

  async loadPack(): Promise<TemplatePack> {
    const v = await idb<unknown>('readonly', (s) => s.get('pack'));
    return v ? parseWith(templatePackSchema, v, '草稿模板庫') : this.fallback.loadPack();
  }

  async loadStations(): Promise<StationsFile> {
    const v = await idb<unknown>('readonly', (s) => s.get('stations'));
    return v ? parseWith(stationsFileSchema, v, '草稿站點設定') : this.fallback.loadStations();
  }

  async savePack(pack: TemplatePack): Promise<void> {
    await idb('readwrite', (s) => s.put(pack, 'pack'));
  }

  async saveStations(stations: StationsFile): Promise<void> {
    await idb('readwrite', (s) => s.put(stations, 'stations'));
  }

  async hasDraft(): Promise<boolean> {
    return !!(await idb<unknown>('readonly', (s) => s.get('pack')));
  }

  async clear(): Promise<void> {
    await idb('readwrite', (s) => s.clear());
  }
}

/**
 * 後端 Repository（預留）。
 * TODO：
 *   - GET /api/stations、GET /api/template-pack?since=<packVersion>（只下載差異）
 *   - 站務端登入後 PUT 模板、記錄廣播紀錄
 *   - 乘客端仍以 Service Worker 快取的版本為準，離線時照樣可用
 */
export interface RemoteRepository extends TemplateRepository, StationRepository {
  readonly endpoint: string;
  publish(bundle: DataBundle): Promise<{ packVersion: number }>;
}

/** 匯出（packVersion 自動 +1） */
export function exportBundle(pack: TemplatePack, stations: StationsFile): DataBundle {
  return { pack: { ...pack, packVersion: (pack.packVersion + 1) % 256 }, stations };
}

/** 匯入並驗證 */
export function importBundle(data: unknown): DataBundle {
  return parseWith(bundleSchema, data, '匯入的 JSON');
}
