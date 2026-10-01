import { Composition } from "remotion";
import { PulseForgePromo, PROMO_DURATION_FRAMES, PROMO_FPS, PROMO_HEIGHT, PROMO_WIDTH } from "./PulseForgePromo";
import {
  AGENT_DURATION_FRAMES,
  AGENT_FPS,
  AGENT_HEIGHT,
  AGENT_WIDTH,
  McpAgentSession,
} from "./McpAgentSession";
import {
  VAGENT_DURATION_FRAMES,
  VAGENT_FPS,
  VAGENT_HEIGHT,
  VAGENT_WIDTH,
  McpAgentSessionVertical,
} from "./McpAgentSessionVertical";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="PulseForgePromo"
        component={PulseForgePromo}
        durationInFrames={PROMO_DURATION_FRAMES}
        fps={PROMO_FPS}
        width={PROMO_WIDTH}
        height={PROMO_HEIGHT}
      />
      <Composition
        id="McpAgentSessionVertical"
        component={McpAgentSessionVertical}
        durationInFrames={VAGENT_DURATION_FRAMES}
        fps={VAGENT_FPS}
        width={VAGENT_WIDTH}
        height={VAGENT_HEIGHT}
      />
      <Composition
        id="McpAgentSession"
        component={McpAgentSession}
        durationInFrames={AGENT_DURATION_FRAMES}
        fps={AGENT_FPS}
        width={AGENT_WIDTH}
        height={AGENT_HEIGHT}
      />
    </>
  );
};
