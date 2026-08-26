export type StyleId = "social_pop" | "neo_editorial" | "tech_motion";
export type SemanticPresetId =
  | "knowledge_focus"
  | "slide_teacher"
  | "classroom_value"
  | "hook_impact"
  | "process_rhythm"
  | "result_close";

export type MotionEventType =
  | "hook"
  | "keyword"
  | "emphasis"
  | "step"
  | "scene"
  | "result"
  | "warning"
  | "quote";

export type MotionLayoutZone = "top_banner" | "upper_left" | "upper_right" | "middle_left" | "middle_right";
export type MotionEventSize = "hero" | "card" | "chip";

export type EffectRendererId =
  | "elasticHeading"
  | "keywordSticker"
  | "svgCallout"
  | "numericStepCard"
  | "chapterBar"
  | "focusFrame"
  | "zoomTransition";

export type EffectSelection = {
  registryVersion: 1;
  componentId: string;
  variantId: string;
  renderer: EffectRendererId;
  motion: string;
  surface: string;
};

export type TimedWord = {
  text: string;
  startMs: number;
  endMs: number;
};

export type MotionEvent = {
  type: MotionEventType;
  text: string;
  startMs: number;
  endMs: number;
  icon: string | null;
  ordinal: number;
  preferredZone: MotionLayoutZone;
  zone: MotionLayoutZone;
  size: MotionEventSize;
  priority: number;
  reason: string | null;
  effect: EffectSelection;
};

export type FocusRect = {
  startMs: number;
  endMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
  effect: EffectSelection;
};

export type ProtectedRect = Omit<FocusRect, "effect"> & {
  role: string;
};

export type MotionManifest = {
  version: 1;
  semanticPresetId: SemanticPresetId;
  styleId: StyleId;
  effectRegistryVersion: 1;
  layoutGridVersion: 1;
  deterministicSeed: string;
  width: 1080;
  height: 1920;
  fps: 30;
  durationMs: number;
  durationInFrames: number;
  title: string;
  sourceFile: string;
  director: {
    version: number;
    provider: string;
    model: string | null;
  };
  captions: TimedWord[];
  events: MotionEvent[];
  focusRects: FocusRect[];
  protectedRects: ProtectedRect[];
};

export type StylePack = {
  id: StyleId;
  kind: "design_system";
  version: 1;
  displayName: string;
  motionGrammar: string;
  video: {
    scale: number;
    pulse: number;
    pulseDivisor: number;
    overlay: string;
  };
  palette: {
    ink: string;
    paper: string;
    accent: string;
    secondary: string;
    signal: string;
  };
  caption: {
    maxWordsPerPage: number;
    placement: string;
    activeScale: number;
  };
  supportedEvents: MotionEventType[];
};
