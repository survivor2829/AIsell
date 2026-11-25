import React from "react";
import { Composition, registerRoot } from "remotion";
import { CaptionTemplate, type TemplateProps } from "./Templates";
import { CreativeTemplate, type CreativeProps } from "./Creative";

const FPS = 30;

function Root() {
  const length = ({ props }: { props: { durationMs: number } }) => ({ durationInFrames: Math.round((props.durationMs / 1000) * FPS) });
  return (
    <>
      <Composition id="CaptionTemplate" component={CaptionTemplate as React.FC<TemplateProps>} width={1080} height={1920} fps={FPS}
        durationInFrames={300} defaultProps={{} as TemplateProps} calculateMetadata={length} />
      <Composition id="CreativeTemplate" component={CreativeTemplate as React.FC<CreativeProps>} width={1080} height={1920} fps={FPS}
        durationInFrames={300} defaultProps={{} as CreativeProps} calculateMetadata={length} />
    </>
  );
}
registerRoot(Root);
