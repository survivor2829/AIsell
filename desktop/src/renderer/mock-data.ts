export type Account = {
  id: number;
  name: string;
  status: "已登录" | "检测中" | "未登录";
};

export type Customer = {
  id: number;
  name: string;
  tag: string;
  lastTouch: string;
  allowed: boolean;
};

export type TouchTask = {
  id: number;
  target: string;
  content: string;
  status: "待发送" | "已阻断" | "已验证发送";
  reason: string;
};

export type RunLog = {
  id: number;
  time: string;
  action: string;
  result: string;
};

export const accounts: Account[] = [];

export const customers: Customer[] = [];

export const touchTasks: TouchTask[] = [];

export const initialLogs: RunLog[] = [];
