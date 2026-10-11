export type OfficialMaterial = {
  id: string; title: string; category: string; kind: "image" | "video"; description: string;
  thumbnailUrl: string; previewUrl?: string; sourceUrl: string; author: string; license: string;
  sha256: string; sizeBytes: number; downloaded: boolean;
};
export type OfficialCatalog = { revision: number; categories: { id: string; label: string }[]; items: OfficialMaterial[]; searchEnabled: boolean };
export type SearchItem = { id: string; title: string; url: string; thumbnailUrl?: string; description: string; source: string; usage: "reference" | "usable"; materialId?: string };
export type SearchUpdate = { taskId: string; status: "searching" | "completed" | "cancelled" | "failed"; round: number; items: SearchItem[]; message?: string };
type Result<T = never> = { ok: boolean; data?: T; error?: string };
declare global {
  interface Window {
    xiaoxiOfficialMaterials?: {
      list(options?: { refresh?: boolean }): Promise<Result<OfficialCatalog>>;
      importMaterial(id: string): Promise<Result<{ assetIds: string[] }>>;
      previewMaterial(id: string): Promise<Result<OfficialMaterial>>;
      openSource(url: string): Promise<Result>;
      search(input: { taskId: string; query: string; localOnly?: boolean }): Promise<Result<SearchUpdate>>;
      cancelSearch(taskId: string): Promise<Result>;
      onSearchUpdate(callback: (update: SearchUpdate) => void): () => void;
    };
  }
}
