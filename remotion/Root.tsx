import { Composition } from "remotion";
import { PulseForgePromo, PROMO_DURATION_FRAMES, PROMO_FPS, PROMO_HEIGHT, PROMO_WIDTH } from "./PulseForgePromo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="PulseForgePromo"
      component={PulseForgePromo}
      durationInFrames={PROMO_DURATION_FRAMES}
      fps={PROMO_FPS}
      width={PROMO_WIDTH}
      height={PROMO_HEIGHT}
    />
  );
};
