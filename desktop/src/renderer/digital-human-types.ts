export type DigitalHumanResult<T> = { ok: boolean; data?: T; error?: string; code?: string };
export type DigitalHumanAsset = { id: string; name: string; previewDataUrl?: string };
export type DigitalHumanDraft = {
  personAssetId: string; productAssetId: string; sceneId: string; voiceStyle: string;
  durationSeconds: number; script: string; title?: string;
  templateId?: 'topic_fixed' | 'key_points'; musicTrackId?: string;
};
export type DigitalHumanTask = DigitalHumanDraft & {
  id: string; title: string; status: string; statusLabel: string; createdAt: string; updatedAt: string;
  previewReady: boolean; previewRevision: string; progress: number; error: string; errorCode: string;
  generatedVideoId: string; packagingTaskId: string; canResume: boolean; canRefresh: boolean;
};
export type DigitalHumanCapabilities = {
  ready: boolean; code: string; message: string; scenes: { id: string; name: string }[]; voices: { id: string; name: string }[];
};
export type DigitalHumanApi = {
  capabilities(): Promise<DigitalHumanResult<DigitalHumanCapabilities>>;
  list(): Promise<DigitalHumanResult<{ items: DigitalHumanTask[] }>>;
  get(payload: { id: string }): Promise<DigitalHumanResult<DigitalHumanTask>>;
  importImage(): Promise<DigitalHumanResult<DigitalHumanAsset | null>>;
  create(payload: DigitalHumanDraft & { id?: string }): Promise<DigitalHumanResult<DigitalHumanTask>>;
  saveAndPreview(payload: DigitalHumanDraft & { id?: string }): Promise<DigitalHumanResult<DigitalHumanTask>>;
  preview(payload: { id: string }): Promise<DigitalHumanResult<DigitalHumanTask>>;
  confirm(payload: { id: string; previewRevision: string }): Promise<DigitalHumanResult<DigitalHumanTask>>;
  refresh(payload: { id: string }): Promise<DigitalHumanResult<DigitalHumanTask>>;
  resume(payload: { id: string }): Promise<DigitalHumanResult<DigitalHumanTask>>;
  media(payload: { id: string }): Promise<DigitalHumanResult<{ dataUrl: string }>>;
  images(payload: { id: string }): Promise<DigitalHumanResult<{ person?: DigitalHumanAsset; product?: DigitalHumanAsset }>>;
};
