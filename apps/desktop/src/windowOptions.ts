import type { BrowserWindowConstructorOptions } from "electron";

export function getPlatformWindowChromeOptions(
  platform: NodeJS.Platform,
):
  | Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "trafficLightPosition">
  | Record<string, never> {
  if (platform !== "darwin") {
    return {};
  }

  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
  };
}
