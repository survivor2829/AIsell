import React from "react";
import { Composition, registerRoot } from "remotion";
import { CaptionTemplate, type TemplateProps } from "./Templates";

const FPS = 30;

function Root() {
  return <Composition id="CaptionTemplate" component={CaptionTemplate as React.FC<TemplateProps>} width={1080} height={1920} fps={FPS}
    durationInFrames={300} defaultProps={{} as TemplateProps}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.round((props.durationMs / 1000) * FPS) })} />;
}
registerRoot(Root);
