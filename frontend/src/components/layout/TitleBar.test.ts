import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import { nextTick } from "vue";
import TitleBar from "./TitleBar.vue";

const native = vi.hoisted(() => ({
  isDesktop: vi.fn(() => true),
  startTitlebarDrag: vi.fn(async () => {}),
  windowControl: vi.fn(async () => {}),
}));
vi.mock("../../services/desktop", () => native);
let wrapper: VueWrapper;
beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  native.isDesktop.mockReturnValue(true);
  native.startTitlebarDrag.mockClear();
});
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });
function render(platform = "macos") {
  wrapper = mount(TitleBar, {
    attachTo: document.body,
    props: { platform, hasRequest: true, sidebarVisible: true },
    global: { plugins: [createPinia()] },
  });
  return wrapper;
}
async function press(selector: string, detail = 1, button = 0) {
  wrapper.get(selector).element.dispatchEvent(new MouseEvent("mousedown", {
    bubbles: true, cancelable: true, detail, button,
  }));
  await nextTick();
}
describe("native titlebar drag routing", () => {
  it("routes direct macOS pointer presses once and stops the built-in drag handler", async () => {
    render();
    const documentHandler = vi.fn();
    document.addEventListener("mousedown", documentHandler);
    try {
      await press("header");
      expect(native.startTitlebarDrag).toHaveBeenCalledTimes(1);
      expect(documentHandler).not.toHaveBeenCalled();
    } finally { document.removeEventListener("mousedown", documentHandler); }
  });
  it("allows the explicit brand drag region", async () => {
    render();
    await press(".titlebar-brand");
    expect(native.startTitlebarDrag).toHaveBeenCalledTimes(1);
  });
  it("never drags interactive controls or their children", async () => {
    render();
    await press('[aria-label="Toggle sidebar"]');
    await press('[aria-label="Toggle sidebar"] svg');
    expect(native.startTitlebarDrag).not.toHaveBeenCalled();
  });
  it.each(["windows", "linux"])("retains Tauri handling on %s", async (platform) => {
    render(platform);
    await press("header");
    expect(native.startTitlebarDrag).not.toHaveBeenCalled();
  });
  it("does not invoke native input from browser preview", async () => {
    native.isDesktop.mockReturnValue(false);
    render();
    await press("header");
    expect(native.startTitlebarDrag).not.toHaveBeenCalled();
  });
  it("keeps double-click maximize and right-click out of custom dragging", async () => {
    render();
    await press("header", 2);
    await press("header", 1, 2);
    expect(native.startTitlebarDrag).not.toHaveBeenCalled();
  });
});
