import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Spike configuration only. `webDir` points at the repo's production build;
 * no second UI is created. Match the Capacitor major to the installed CLI.
 */
const config: CapacitorConfig = {
  appId: "app.kyx.studio",
  appName: "KYX",
  webDir: "../../dist",
  server: { androidScheme: "https" },
  android: { allowMixedContent: false },
};

export default config;
