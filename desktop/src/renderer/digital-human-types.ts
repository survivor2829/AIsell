export type DigitalHumanResult<T> = { ok: boolean; data?: T; error?: string; code?: string; operationId?: string; outcomeUnknown?: boolean };
export type DigitalHumanAsset = { id: string; name: string; previewDataUrl?: string; seconds?: number };
export type DigitalHumanVoiceClone = { speakerId: string; name?: string; status?: number | string; usable?: boolean; trainable?: boolean; operationId?: string; slotType?: string };
export type DigitalHumanDraft = {
  personAssetId: string; productAssetId: string; sceneId: string; voiceStyle: string;
  sourceTaskId?: string;
  voiceSource?: 'official' | 'uploaded_audio' | 'cloned_voice'; voicePersonaId?: string; audioAssetId?: string; characterVoice?: 'male' | 'female' | 'unknown';
  durationSeconds: number; script: string; title?: string; budgetCny?: number;
  templateId?: 'topic_fixed' | 'key_points'; musicTrackId?: string;
};
export type DigitalHumanTask = DigitalHumanDraft & {
  reusedAudioFrom?: string; voiceName?: string; audioName?: string; actualDurationSeconds?: number; narrationPolicy?: 'original_script';
  id: string; pipelineVersion?: number; title: string; status: string; statusLabel: string; createdAt: string; updatedAt: string;
  previewReady: boolean; previewRevision: string; progress: number; error: string; errorCode: string;
  generatedVideoId: string; packagingTaskId: string; canResume: boolean; canRefresh: boolean;
  videoResolution?: string; outputQuality?: string; directorSkillVersion?: string;
  quote?: { ready?: boolean; estimatedCny?: number; maximumCny?: number; budgetCny?: number; reservedCny?: number; actualCny?: number | null; pendingCny?: number; remainingCny?: number; note?: string };
  audio?: { prepared?: boolean; seconds?: number; speechSeconds?: number; coverage?: number; segmentCount?: number };
};
export type DigitalHumanCapabilities = {
  ready: boolean; code: string; message: string; scenes: { id: string; name: string }[]; voices: { id: string; name: string; gender?: 'male' | 'female' | 'unknown'; available?: boolean; availability?: string; digitalHumanDefault?: boolean }[];
  voicePreferences?: Record<string, string>; voiceClone?: { ready?: boolean; enabled?: boolean; inventoryConfigured?: boolean; message?: string; reason?: string; inventory_configured?: boolean };
};
export type DigitalHumanApi = {
  capabilities(): Promise<DigitalHumanResult<DigitalHumanCapabilities>>;
  list(): Promise<DigitalHumanResult<{ items: DigitalHumanTask[] }>>;
  get(payload: { id: string }): Promise<DigitalHumanResult<DigitalHumanTask>>;
  importAudio(): Promise<DigitalHumanResult<DigitalHumanAsset | null>>;
  recommendVoice(payload: { personAssetId: string }): Promise<DigitalHumanResult<{ characterVoice: 'male' | 'female' | 'unknown'; voicePersonaId: string; reason: string }>>;
  previewVoice(payload: { voicePersonaId: string }): Promise<DigitalHumanResult<{ audioDataUrl: string; cacheHit: boolean }>>;
  selectVoice(payload: { voicePersonaId: string; characterVoice: 'male' | 'female' }): Promise<DigitalHumanResult<unknown>>;
  voiceClones(): Promise<DigitalHumanResult<{ items?: DigitalHumanVoiceClone[]; message?: string; ready?: boolean }>>;
  trainVoice(payload: { speakerId: string; audioAssetId: string; customerConsent: boolean }): Promise<DigitalHumanResult<{ operationId?: string; speakerId?: string; status?: number | string; message?: string }>>;
  cloneStatus(payload: { speakerId: string; operationId?: string }): Promise<DigitalHumanResult<{ status?: number | string; message?: string }>>;
  speechMedia(payload: { id: string }): Promise<DigitalHumanResult<{ audioDataUrl: string }>>;
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
