import { afterEach, expect, it } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import UiModal from "./UiModal.vue";

let wrapper: VueWrapper | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; document.body.replaceChildren(); });
const backdrop = () => document.querySelector('.modal-backdrop')!;
const panel = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
function pointer(target: Element, type: string, id = 1, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, button });
  Object.defineProperty(event, "pointerId", { value: id });
  target.dispatchEvent(event);
}
function click(target = backdrop()) {
  pointer(target, "pointerdown"); pointer(target, "pointerup");
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}
async function render(props: Partial<InstanceType<typeof UiModal>["$props"]> = {}) {
  wrapper = mount(UiModal, { props: { open: true, title: "Synthetic modal", ...props }, attachTo: document.body,
    slots: { default: '<button data-autofocus>Primary</button>' } });
  await flushPromises();
}

it("preserves default autofocus and does not dismiss on backdrop clicks", async () => {
  await render();
  expect(document.activeElement?.textContent).toBe("Primary");
  click(); await flushPromises();
  expect(wrapper!.emitted("close")).toBeUndefined();
});
it("preserves first-control autofocus when no data-autofocus is supplied", async () => {
  wrapper = mount(UiModal, { props: { open: true, title: "Synthetic modal" }, attachTo: document.body });
  await flushPromises();
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Close dialog"]'));
});
it("opts into panel focus while retaining Tab/Shift+Tab trapping and focus restoration", async () => {
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  await render({ initialFocus: "panel" });
  expect(document.activeElement).toBe(panel());
  const buttons = panel().querySelectorAll<HTMLButtonElement>('button');
  const key = (shiftKey = false) => panel().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
  key(); expect(document.activeElement).toBe(buttons[0]);
  key(true); expect(document.activeElement).toBe(buttons[1]);
  key(); expect(document.activeElement).toBe(buttons[0]);
  panel().focus(); key(true); expect(document.activeElement).toBe(buttons[1]);
  await wrapper!.setProps({ open: false }); expect(document.activeElement).toBe(opener);
});
it("dismisses a completed backdrop click only when opted in", async () => {
  await render({ dismissOnBackdrop: true });
  click(); await flushPromises(); expect(wrapper!.emitted("close")).toEqual([[]]);
});
it.each(["panel-to-backdrop", "backdrop-to-panel"])("does not dismiss a %s drag", async direction => {
  await render({ dismissOnBackdrop: true });
  pointer(direction === "panel-to-backdrop" ? panel() : backdrop(), "pointerdown");
  pointer(direction === "panel-to-backdrop" ? backdrop() : panel(), "pointerup");
  backdrop().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(wrapper!.emitted("close")).toBeUndefined();
  click(); expect(wrapper!.emitted("close")).toEqual([[]]);
});
it("ignores panel clicks, right clicks, cancelled gestures and mismatched pointers", async () => {
  await render({ dismissOnBackdrop: true });
  click(panel());
  pointer(backdrop(), "pointerdown", 1, 2); pointer(backdrop(), "pointerup", 1, 2);
  backdrop().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  pointer(backdrop(), "pointerdown"); pointer(backdrop(), "pointercancel"); pointer(backdrop(), "pointerup");
  backdrop().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  pointer(backdrop(), "pointerdown", 1); pointer(backdrop(), "pointerup", 2);
  backdrop().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(wrapper!.emitted("close")).toBeUndefined();
});
it("blocks backdrop, X and Escape dismiss while busy", async () => {
  await render({ dismissOnBackdrop: true, busy: true });
  click();
  document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click();
  panel().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(wrapper!.emitted("close")).toBeUndefined();
  await wrapper!.setProps({ busy: false }); click(); expect(wrapper!.emitted("close")).toEqual([[]]);
});
