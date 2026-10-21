import { useCallback, useEffect, useRef, useState } from 'react';

export type WorkbenchResult<T> = { ok: boolean; state?: T; result?: unknown; error?: string; code?: string };
export type WorkbenchApi = { invoke: (action: string, payload?: unknown) => Promise<WorkbenchResult<unknown>>; onUpdate: (listener: (state: unknown) => void) => () => void };
declare global { interface Window { xiaoxiMapAcquisition?: WorkbenchApi } }

export function useWorkbench<T>(api?: WorkbenchApi) {
  const [state, setState] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  useEffect(() => {
    if (!api) { setError('桌面服务尚未连接，请重新打开应用。'); setLoading(false); return; }
    let disposed = false, received = false;
    const unsubscribe = api.onUpdate(value => { if (!disposed) { received = true; setState(value as T); } });
    void api.invoke('status').then(result => {
      if (disposed) return;
      if (result.state && !received) setState(result.state as T);
      if (!result.ok) setError(result.error || '记录读取失败。');
    }).catch(() => { if (!disposed) setError('记录读取失败，请重新打开页面。'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; unsubscribe(); };
  }, [api]);
  const run = useCallback(async (action: string, payload: unknown = {}, message = '') => {
    if (!api || lock.current) return;
    lock.current = true; setPending(action); setError(''); setNotice('');
    try {
      const result = await api.invoke(action, payload);
      if (Object.prototype.hasOwnProperty.call(result, 'state')) setState(result.state as T);
      if (!result.ok) { setError(result.error || '操作未完成，已有资料已保留。'); return; }
      setNotice(message); return result;
    } catch { setError('操作未完成，请检查连接，已有记录已保留。'); }
    finally { lock.current = false; setPending(''); }
  }, [api]);
  return { state, loading, pending, error, notice, run };
}

export const dateText = (value?: string) => value ? new Date(value).toLocaleString('zh-CN') : '尚未记录';
export const statusText: Record<string, string> = { draft: '待开始', idle: '未开始', waiting: '未开始', running: '进行中', paused: '已暂停', completed: '本轮完成', blocked: '待处理', interrupted: '已中断', failed: '失败', pending: '待确认', approved: '已审稿', executing: '执行中', submitted: '已提交', reviewing: '平台审核中', public: '已公开', published: '已公开', outcome_unknown: '结果待核对', unknown: '未知', connected: '已连接', authorized: '已授权', login_required: '待登录', closed: '未连接', verification_required: '待人工验证', identity_unavailable: '账号待确认' };
export const safeExternalUrl = (value?: string) => {
  try { const url = new URL(value || ''); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
};
