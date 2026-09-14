import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import UiMenu from "./UiMenu.vue";
import UiModal from "./UiModal.vue";
import UiTabs from "./UiTabs.vue";
import JsonPreview from "../editor/JsonPreview.vue";

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount());
  document.body.replaceChildren();
});

describe("UI primitives", () => {
  it("menu skips disabled entries, handles Escape, and restores focus", async () => {
    const wrapper = mount(UiMenu, {
      attachTo: document.body,
      props: {
        label: "Options",
        items: [
          { id: "a", label: "A" },
          { id: "b", label: "B", disabled: true },
          { id: "c", label: "C" },
        ],
      },
    });
    mounted.push(wrapper);
    await wrapper.get("button").trigger("keydown", { key: "ArrowDown" });
    await nextTick();
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement?.textContent).toContain("A");
    menu.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement?.textContent).toContain("C");
    menu.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await nextTick();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(wrapper.get("button").element);
  });
  it("pointer opening focuses the menu without preselecting its first item", async () => {
    const wrapper = mount(UiMenu, {
      attachTo: document.body,
      props: {
        label: "Collection actions",
        items: [
          { id: "new-request", label: "New request" },
          { id: "rename", label: "Rename" },
        ],
      },
    });
    mounted.push(wrapper);
    await wrapper.get("button").trigger("click", { detail: 1 });
    await nextTick();
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement).toBe(menu);
    expect(wrapper.emitted("select")).toBeUndefined();
    menu.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement?.textContent?.trim()).toBe("New request");
  });
  it("context menus distinguish pointer and keyboard opening and restore the external trigger", async () => {
    const wrapper = mount(UiMenu, {
      attachTo: document.body,
      props: {
        label: "Collection actions",
        items: [
          { id: "new-request", label: "New request" },
          { id: "disabled", label: "Disabled", disabled: true },
          { id: "rename", label: "Rename" },
        ],
      },
    });
    mounted.push(wrapper);
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    await wrapper.vm.openAt(100, 100, trigger);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement).toBe(menu);
    menu.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    expect(document.activeElement?.textContent?.trim()).toBe("Rename");
    menu.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await nextTick();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await wrapper.vm.openAt(100, 100, trigger, true);
    expect(document.activeElement?.textContent?.trim()).toBe("New request");
    expect(wrapper.emitted("select")).toBeUndefined();
  });
  it("modal traps focus, emits close on Escape, and restores prior focus", async () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const wrapper = mount(UiModal, {
      attachTo: document.body,
      props: { open: true, title: "Confirm" },
      slots: {
        default: "A fixture action",
        footer: "<button data-autofocus>Cancel</button><button>Delete</button>",
      },
    });
    mounted.push(wrapper);
    await nextTick();
    expect(document.activeElement?.textContent).toBe("Cancel");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const options = dialog.querySelectorAll<HTMLButtonElement>("button");
    options[options.length - 1]?.focus();
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(options[0]);
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(wrapper.emitted("close")).toHaveLength(1);
    await wrapper.setProps({ open: false });
    expect(document.activeElement).toBe(button);
  });
  it("tabs use roving focus and arrow navigation", async () => {
    const wrapper = mount(UiTabs, {
      attachTo: document.body,
      props: {
        label: "Sections",
        modelValue: "one",
        tabs: [
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
        ],
      },
    });
    mounted.push(wrapper);
    const first = wrapper.findAll("button")[0]!;
    (first.element as HTMLButtonElement).focus();
    await first.trigger("keydown", { key: "ArrowRight" });
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["two"]);
  });
  it("renders untrusted preview data as text, not HTML", () => {
    const value = '{"html":"<img src=x onerror=alert(1)>"}';
    const wrapper = mount(JsonPreview, { props: { value, label: "Response" } });
    mounted.push(wrapper);
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.text()).toContain("<img");
  });
});
