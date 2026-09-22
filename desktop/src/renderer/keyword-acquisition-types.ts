export type KeywordTask = { id: string; name: string; keywords: string[]; firstMessage: string; limit: number; contactLimit: number; expertRef: "default"; autoContact: boolean; status: string; lastRunId?: string };
export type KeywordRun = { id: string; taskId: string; status: string; observed: number; leadIds: string[]; detail: string; reason: string; startedAt: string; finishedAt?: string };
export type KeywordLead = { id: string; taskId: string; accountId: string; peerId: string; name: string; source: "douyin" | "manual"; sourceUrl: string; keyword: string; comment: string; signals: string[]; status: string; notes: string; createdAt: string };
export type KeywordMessage = { id: string; direction: "incoming" | "outgoing"; text: string; createdAt: string };
export type KeywordConversation = { id: string; leadId: string; mode: "human" | "auto"; draft: string; messages: KeywordMessage[]; updatedAt: string; lastReason?: string };
export type KeywordAttempt = { id: string; leadId: string; status: string; text: string; reason?: string };
export type KeywordState = {
  tasks: KeywordTask[]; runs: KeywordRun[]; leads: KeywordLead[]; conversations: KeywordConversation[]; attempts: KeywordAttempt[];
  browser: { state: string; account: { id: string; name: string } | null; capabilities: { discover: boolean; send: boolean; inbox: boolean } };
  expertReady: boolean; busy: boolean;
};
export type KeywordResult = { ok: boolean; state?: KeywordState; code?: string; error?: string };
export type KeywordTaskInput = { id?: string; name: string; keywords: string | string[]; firstMessage: string; limit: number; contactLimit: number; autoContact: boolean };
export type KeywordApi = {
  status(): Promise<KeywordResult>;
  saveTask(payload: KeywordTaskInput): Promise<KeywordResult>;
  startTask(taskId: string): Promise<KeywordResult>;
  stop(): Promise<KeywordResult>;
  openBrowser(): Promise<KeywordResult>;
  refreshAccount(): Promise<KeywordResult>;
  saveLead(payload: { id?: string; name?: string; comment?: string; notes?: string; status?: string }): Promise<KeywordResult>;
  saveConversation(payload: { leadId: string; draft?: string; mode?: "human" | "auto" }): Promise<KeywordResult>;
  openSource(leadId: string): Promise<KeywordResult>;
  openConversation(leadId: string): Promise<KeywordResult>;
  syncConversation(leadId: string): Promise<KeywordResult>;
  generateDraft(leadId: string): Promise<KeywordResult>;
  sendDraft(leadId: string): Promise<KeywordResult>;
  onUpdate(callback: (state: KeywordState) => void): () => void;
};
declare global { interface Window { xiaoxiKeywordAcquisition?: KeywordApi } }
