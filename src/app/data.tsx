/**
 * 全域資料：模板庫與站點設定（從 BundledRepository 載入，Service Worker 快取後離線可用）。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { BundledRepository } from '../data/repository.ts';
import type { StationsFile, TemplatePack } from '../data/schema.ts';

export interface AppData {
  pack: TemplatePack;
  stations: StationsFile;
}

type State =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: AppData };

const Ctx = createContext<State>({ status: 'loading' });

export function DataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    const repo = new BundledRepository();
    Promise.all([repo.loadPack(), repo.loadStations()])
      .then(([pack, stations]) => setState({ status: 'ready', data: { pack, stations } }))
      .catch((e: unknown) =>
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
      );
  }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

/** 取得資料載入狀態 */
export const useDataState = () => useContext(Ctx);

/** 資料載入完成後才渲染子元件 */
export function WithData({ children }: { children: (d: AppData) => ReactNode }) {
  const s = useDataState();
  if (s.status === 'loading') return <p role="status">載入模板庫中…</p>;
  if (s.status === 'error')
    return (
      <div className="error" role="alert">
        <strong>資料載入失敗</strong>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{s.message}</pre>
      </div>
    );
  return <>{children(s.data)}</>;
}
