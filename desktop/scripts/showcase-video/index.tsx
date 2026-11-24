import React from "react";
import { Composition, registerRoot } from "remotion";
import { Showcase, type ShowcaseProps } from "./Showcase";

const FPS = 30;
const frames = (props: ShowcaseProps) => Math.round((props.introSeconds + props.shotSeconds * props.segments.length + props.endSeconds) * FPS);

function Root() {
  return <Composition id="Showcase" component={Showcase as React.FC<ShowcaseProps>} width={1080} height={1920} fps={FPS}
    durationInFrames={300} defaultProps={{} as ShowcaseProps}
    calculateMetadata={({ props }) => ({ durationInFrames: frames(props) })} />;
}
registerRoot(Root);
