import { useEffect, useState } from "react";

type Billing = { balance: number; blocked: boolean; unblocked: boolean } | null;
type BillingApi = { billing?: () => Promise<Billing> };

const REFRESH_MS = 60_000;
const formatWan = (points: number) => `${(points / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万`;

// 顶栏算力余额：只显示主进程从网关读到的数，读不到时不显示。
export default function BillingBadge({ enabled }: { enabled: boolean }) {
  const [billing, setBilling] = useState<Billing>(null);
  useEffect(() => {
    const api = (window as unknown as { xiaoxiAccount?: BillingApi }).xiaoxiAccount;
    if (!enabled || !api?.billing) { setBilling(null); return; }
    let alive = true;
    const read = () => void api.billing!().then((next) => { if (alive) setBilling(next); }).catch(() => undefined);
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    window.addEventListener("focus", read);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", read); };
  }, [enabled]);
  if (!billing) return null;
  if (billing.blocked) {
    return <span className="billing-badge empty" role="status" title="余额用完后不能开始新的 AI 制作，正在做的会做完。">算力已用完，请联系客服充值</span>;
  }
  return <span className="billing-badge" title="1 元 = 4 万算力。AI 制作按实际用量扣，失败的视频不扣。">算力 {billing.balance < 0 ? `欠 ${formatWan(-billing.balance)}` : formatWan(billing.balance)}</span>;
}
