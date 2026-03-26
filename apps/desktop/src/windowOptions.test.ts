import { describe, expect, it } from "vitest";

import { getPlatformWindowChromeOptions } from "./windowOptions";

describe("getPlatformWindowChromeOptions", () => {
  it("uses the inset title bar on macOS", () => {
    expect(getPlatformWindowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
    });
  });

  it("keeps the native window chrome on linux", () => {
    expect(getPlatformWindowChromeOptions("linux")).toEqual({});
  });

  it("keeps the native window chrome on windows", () => {
    expect(getPlatformWindowChromeOptions("win32")).toEqual({});
  });
});
