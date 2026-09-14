import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapDesktop, parseBootstrap, setWindowTheme } from "./desktop";
const native = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  setTheme: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: native.isTauri,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme: native.setTheme }),
}));
beforeEach(() => {
  native.isTauri.mockReturnValue(false);
  native.setTheme.mockClear();
});
const valid = {
  schemaVersion: 5,
  name: "PostMen",
  version: "0.2.0",
  platform: "macos",
  milestone: "M4",
  databaseReady: true,
  httpReady: true,
};
describe("desktop contract", () => {
  it("accepts the Rust DTO", () => {
    expect(parseBootstrap(valid)).toEqual(valid);
  });
  it.each([
    null,
    {},
    { ...valid, schemaVersion: 1 },
    { ...valid, databaseReady: false },
    { ...valid, version: 2 },
  ])("rejects incompatible payload %j", (value) => {
    expect(() => parseBootstrap(value)).toThrow();
  });
  it("does not pretend browser preview has native IPC", async () => {
    expect(await bootstrapDesktop()).toBeNull();
  });
  it("clears the native appearance override for System and preserves explicit themes", async () => {
    native.isTauri.mockReturnValue(true);
    await setWindowTheme("system");
    expect(native.setTheme).toHaveBeenLastCalledWith(null);
    await setWindowTheme("light");
    expect(native.setTheme).toHaveBeenLastCalledWith("light");
    await setWindowTheme("dark");
    expect(native.setTheme).toHaveBeenLastCalledWith("dark");
  });
  it("does not call native theme APIs in browser preview", async () => {
    await setWindowTheme("system");
    expect(native.setTheme).not.toHaveBeenCalled();
  });
});
