import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.inkpop.reader",
  appName: "Inkpop",
  webDir: "dist",
  // Native HTTP avoids browser CORS limits when calling the MangaDex API
  plugins: { CapacitorHttp: { enabled: true } },
};

export default config;
