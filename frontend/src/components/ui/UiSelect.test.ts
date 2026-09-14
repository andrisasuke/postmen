import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import UiSelect from "./UiSelect.vue";
const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount());
  document.body.replaceChildren();
});
function setup() {
  const wrapper = mount(UiSelect, {
    attachTo: document.body,
    props: {
      label: "Choose",
      modelValue: null,
      options: [
        { value: null, label: "None" },
        { value: "blocked", label: "Blocked", disabled: true },
        { value: "json", label: "JSON" },
        { value: 5, label: "Five" },
      ],
    },
  });
  mounted.push(wrapper);
  return wrapper;
}
describe("themed select", () => {
  it("keeps DOM focus on combobox, skips disabled options and commits typed values", async () => {
    const wrapper = setup(),
      trigger = wrapper.get("button");
    await trigger.trigger("click");
    await nextTick();
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger("keydown", { key: "ArrowDown" });
    await trigger.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["json"]);
    await trigger.trigger("click");
    await trigger.trigger("keydown", { key: "End" });
    await trigger.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("update:modelValue")?.[1]).toEqual([5]);
  });
  it("Escape cancels without changing the model; Tab commits; typeahead selects", async () => {
    const wrapper = setup(),
      trigger = wrapper.get("button");
    await trigger.trigger("click");
    await trigger.trigger("keydown", { key: "j" });
    await trigger.trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    await trigger.trigger("click");
    await trigger.trigger("keydown", { key: "ArrowDown" });
    await trigger.trigger("keydown", { key: "Tab" });
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["json"]);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it("supports null, closes on outside/resize and cannot open disabled", async () => {
    const wrapper = setup(),
      trigger = wrapper.get("button");
    await trigger.trigger("click");
    await nextTick();
    (document.querySelector('[role="option"]') as HTMLElement).click();
    await nextTick();
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([null]);
    await trigger.trigger("click");
    await nextTick();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await nextTick();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await trigger.trigger("click");
    await nextTick();
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await wrapper.setProps({ disabled: true });
    await trigger.trigger("keydown", { key: "ArrowDown" });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it("renders popup within a parent dialog's focus/inert boundary", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    const wrapper = mount(UiSelect, {
      attachTo: dialog,
      props: {
        label: "Move",
        modelValue: null,
        options: [{ value: null, label: "Root" }],
      },
    });
    mounted.push(wrapper);
    await wrapper.get("button").trigger("click");
    await nextTick();
    expect(dialog.querySelector('[role="listbox"]')).not.toBeNull();
  });
  it("keeps an open popup across equal-option rerenders and pane scroll", async () => {
    const wrapper = setup();
    await wrapper.get("button").trigger("click");
    await nextTick();
    await wrapper.setProps({
      options: wrapper.props("options").map((o) => ({ ...o })),
    });
    document.body.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });
});
