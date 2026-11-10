// The one list of categories the renderer accepts (deep links included); tutorials.cjs and server tutorials.py keep theirs in step.
export const TUTORIAL_CATEGORIES = ['short-video', 'wechat', 'accounts', 'business', 'product-detail', 'materials'] as const;
export type TutorialCategory = typeof TUTORIAL_CATEGORIES[number];
export type TutorialTopic = 'digital-human' | 'ai-editing' | 'product-video';
export type Tutorial = { id: string; title: string; category: TutorialCategory; topic: TutorialTopic | ''; durationSeconds: number; coverUrl: string; availableOffline: boolean };
export type TutorialCatalog = { revision: number; items: Tutorial[]; offline: boolean };
type Result<T = never> = { ok: boolean; data?: T; error?: string };
declare global {
  interface Window {
    xiaoxiTutorials?: {
      list(options?: { refresh?: boolean }): Promise<Result<TutorialCatalog>>;
      play(id: string): Promise<Result<{ id: string; url: string }>>;
      cancel(id: string): Promise<Result>;
      onProgress(callback: (value: { id: string; percent: number }) => void): () => void;
    };
  }
}
