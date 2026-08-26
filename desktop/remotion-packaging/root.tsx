import React from "react";
import { Composition } from "remotion";

import { DynamicPackaging } from "./video-template";
import type { MotionManifest } from "./types";

const defaultProps: MotionManifest = {
  version: 1,
  semanticPresetId: "knowledge_focus",
  styleId: "social_pop",
  effectRegistryVersion: 1,
  layoutGridVersion: 1,
  deterministicSeed: "remotion-preview",
  width: 1080,
  height: 1920,
  fps: 30,
  durationMs: 10_000,
  durationInFrames: 300,
  title: "动态包装预览",
  sourceFile: "source.mp4",
  director: {
    version: 1,
    provider: "local",
    model: null
  },
  captions: [],
  events: [],
  focusRects: [],
  protectedRects: []
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="DynamicPackaging"
    component={DynamicPackaging}
    width={defaultProps.width}
    height={defaultProps.height}
    fps={defaultProps.fps}
    durationInFrames={defaultProps.durationInFrames}
    defaultProps={defaultProps}
    calculateMetadata={({ props }) => ({
      width: props.width,
      height: props.height,
      fps: props.fps,
      durationInFrames: props.durationInFrames
    })}
  />
);
