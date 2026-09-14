import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import VariableInput from "./VariableInput.vue";
import { HEADER_NAMES, headerValueSuggestions } from "../../services/header-suggestions";

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("header autocomplete alongside environment variables", () => {
  it("hides suggestions on empty focus, whitespace and after clearing either header field", async () => {
    const wrapper = setup();
    const input = wrapper.get("input");
    for (const completions of [HEADER_NAMES, headerValueSuggestions("Content-Type")]) {
      await wrapper.setProps({ completions });
      await input.setValue("");
      await input.trigger("focus");
      await input.trigger("click");
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      await input.setValue("   ");
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      await input.setValue("a");
      expect(document.querySelector('[role="listbox"]')).not.toBeNull();
      await input.setValue("");
      expect(document.querySelector('[role="listbox"]')).toBeNull();
    }
  });
  it("filters names by case-insensitive prefix and accepts a plain header with Enter", async () => {
    const wrapper = setup();
    await wrapper.setProps({ completions: HEADER_NAMES });
    const input = wrapper.get("input");
    await input.trigger("focus");
    await input.setValue("cO");
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options.length).toBeGreaterThan(1);
    expect(options.every(option => option.textContent!.toLowerCase().startsWith("co"))).toBe(true);
    const first = options[0]!.textContent;
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.props("modelValue")).toBe(first);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it("accepts header values by keyboard and updates suggestions when the header changes", async () => {
    const wrapper = setup();
    await wrapper.setProps({ completions: headerValueSuggestions("Content-Type") });
    const input = wrapper.get("input");
    await input.trigger("focus");
    await input.setValue("application/j");
    await input.trigger("keydown", { key: "Tab" });
    expect(wrapper.props("modelValue")).toBe("application/json");
    await input.setValue("");
    await wrapper.setProps({ completions: headerValueSuggestions("Authorization") });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await input.setValue("Be");
    expect(document.querySelector('[role="option"]')?.textContent).toBe("Bearer ");
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.props("modelValue")).toBe("Bearer ");
  });
  it("keeps environment token completion inside an authorization value", async () => {
    const wrapper = setup();
    await wrapper.setProps({ completions: headerValueSuggestions("Authorization") });
    const input = wrapper.get("input");
    await input.trigger("focus");
    await input.setValue("Bearer <<api");
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.props("modelValue")).toBe("Bearer <<api_url>>");
  });
  it("supports pointer selection, dismissal, free text and readonly fields", async () => {
    const wrapper = setup();
    await wrapper.setProps({ completions: HEADER_NAMES });
    const input = wrapper.get("input");
    await input.trigger("focus");
    await input.setValue("content-ty");
    document.querySelector('[role="option"]')!.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(wrapper.props("modelValue")).toBe("Content-Type");
    await input.setValue("co");
    await input.trigger("keydown", { key: "Escape" });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await input.setValue("X-My-Custom-Header");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(wrapper.props("modelValue")).toBe("X-My-Custom-Header");
    await input.setValue("co");
    await wrapper.setProps({ readonly: true });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});
function setup(value = "", attachTo: HTMLElement = document.body) {
  const wrapper = mount(VariableInput, {
    attachTo,
    props: {
      label: "Request URL", modelValue: value,
      variables: [
        { name: "api_url", value: "https://example.test", description: "", scope: "Collection" },
        { name: "api_version", value: "v1", description: "", scope: "Global" },
      ],
      "onUpdate:modelValue": (modelValue: string) => { void wrapper.setProps({ modelValue }); },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}
describe("environment variable autocomplete", () => {
  it("filters at the cursor and inserts with keyboard without submitting", async () => {
    const wrapper = setup();
    const input = wrapper.get("input");
    await input.trigger("focus");
    await input.setValue("<<api");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: "Tab" });
    expect(wrapper.props("modelValue")).toBe("<<api_version>>");
    expect(input.element.selectionStart).toBe(15);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it("replaces a complete token at the cursor while preserving the URL suffix", async () => {
    const wrapper = setup("<<api_url>>/users");
    const input = wrapper.get("input");
    input.element.setSelectionRange(5, 5);
    await input.trigger("focus");
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.props("modelValue")).toBe("<<api_url>>/users");
    expect(input.element.selectionStart).toBe(11);
  });
  it("Escape dismisses, disabled and composing inputs do not autocomplete", async () => {
    const wrapper = setup("<<api");
    const input = wrapper.get("input");
    input.element.setSelectionRange(5, 5);
    await input.trigger("focus");
    await input.trigger("keydown", { key: "Escape" });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await input.trigger("click");
    await input.trigger("compositionstart");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await input.trigger("compositionend");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    await wrapper.setProps({ disabled: true });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(wrapper.props("modelValue")).toBe("<<api");
  });
  it("keeps pointer suggestions within modal and distinguishes unresolved tokens", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    const wrapper = setup("<<api", dialog);
    const input = wrapper.get("input");
    input.element.setSelectionRange(5, 5);
    await input.trigger("focus");
    await nextTick();
    const option = dialog.querySelector('[role="option"]');
    expect(option).not.toBeNull();
    option!.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(wrapper.props("modelValue")).toBe("<<api_url>>");
    await wrapper.setProps({ modelValue: "<<api_url>>/<<missing>>" });
    expect(wrapper.get(".resolved").text()).toBe("<<api_url>>");
    expect(wrapper.get(".unresolved").text()).toBe("<<missing>>");
  });
});

function rectangle(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) };
}
function hoverGeometry(wrapper: ReturnType<typeof setup>, tokenRects = [rectangle(105, 105, 90, 20)]) {
  vi.spyOn(wrapper.get("input").element, "getBoundingClientRect").mockReturnValue(rectangle(100, 100, 220, 30));
  vi.spyOn(wrapper.get(".variable-mirror").element, "getBoundingClientRect").mockReturnValue(rectangle(100, 100, 220, 30));
  wrapper.findAll("[data-variable-index]").forEach((span, index) => {
    vi.spyOn(span.element, "getBoundingClientRect").mockReturnValue(tokenRects[index] ?? rectangle(0, 0, 0, 0));
  });
}
async function hover(wrapper: ReturnType<typeof setup>, x = 120, y = 115, buttons = 0) {
  const event = new Event("pointermove", { bubbles: true });
  Object.assign(event, { clientX: x, clientY: y, buttons, pointerType: "mouse" });
  wrapper.get("input").element.dispatchEvent(event);
  await nextTick(); await nextTick();
}
describe("variable value hover tooltip", () => {
  it("shows the resolved value and scope only above a variable, without editing input", async () => {
    const wrapper = setup("<<api_url>>/users"); hoverGeometry(wrapper);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await hover(wrapper);
    const tooltip = document.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toContain("https://example.test");
    expect(tooltip.textContent).toContain("Collection");
    expect(wrapper.get("input").attributes("aria-describedby")).toBe(tooltip.id);
    expect(wrapper.props("modelValue")).toBe("<<api_url>>/users");
    await hover(wrapper, 280);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(wrapper.get("input").attributes("aria-describedby")).toBeUndefined();
  });
  it("uses the selected variable values including nested references and clears stale tooltips", async () => {
    const wrapper = setup("<<nested>>");
    await wrapper.setProps({ variables: [
      { name: "nested", value: "<<api_url>>/users", description: "", scope: "Collection" },
      { name: "api_url", value: "https://local.test", description: "", scope: "Collection" },
    ] });
    hoverGeometry(wrapper); await hover(wrapper);
    expect(document.querySelector(".variable-tooltip-value")!.textContent).toBe("https://local.test/users");
    await wrapper.setProps({ variables: [{ name: "nested", value: "https://global.test", description: "", scope: "Global" }] });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await hover(wrapper);
    expect(document.querySelector(".variable-tooltip-value")!.textContent).toBe("https://global.test");
    expect(document.querySelector(".variable-tooltip-heading")!.textContent).toContain("Global");
  });
  it("handles empty, unresolved and cyclic variables, and renders values as inert text", async () => {
    const wrapper = setup("<<test>>");
    for (const value of ["", '<img src=x onerror="alert(1)">', "<<test>>"]) {
      await wrapper.setProps({ variables: [{ name: "test", value, description: "", scope: "Collection" }] });
      hoverGeometry(wrapper); await hover(wrapper);
      const tooltip = document.querySelector('[role="tooltip"]')!;
      expect(tooltip.querySelector("img")).toBeNull();
      if (value === "<<test>>") expect(tooltip.textContent).toContain("cycle");
      else expect(tooltip.querySelector(".variable-tooltip-value")!.textContent).toBe(value || "(empty value)");
    }
    await wrapper.setProps({ variables: [] });
    hoverGeometry(wrapper); await hover(wrapper);
    expect(document.querySelector(".variable-tooltip-error")!.textContent).toContain("not enabled");
  });
  it("hit-tests only the visible part after horizontal scrolling and suppresses tooltip during selection", async () => {
    const wrapper = setup("<<api_url>>/users");
    hoverGeometry(wrapper, [rectangle(40, 105, 120, 20)]);
    await hover(wrapper, 80); expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await hover(wrapper, 110); expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await hover(wrapper, 110, 115, 1); expect(document.querySelector('[role="tooltip"]')).toBeNull();
    wrapper.get("input").element.scrollLeft = 60;
    await wrapper.get("input").trigger("scroll");
    expect(wrapper.get(".variable-mirror > span").attributes("style")).toContain("translateX(-60px)");
  });
  it("can be hovered for reading and dismissed by Escape, resize, blur or leaving", async () => {
    vi.useFakeTimers();
    const wrapper = setup("<<api_url>>"); hoverGeometry(wrapper); await hover(wrapper);
    await wrapper.get(".variable-input").trigger("pointerleave");
    document.querySelector('[role="tooltip"]')!.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(150); await nextTick();
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await nextTick();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    for (const type of ["resize", "blur"]) {
      await hover(wrapper); window.dispatchEvent(new Event(type)); await nextTick();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    }
    await hover(wrapper); await wrapper.get(".variable-input").trigger("pointerleave");
    vi.advanceTimersByTime(150); await nextTick();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
  it("stays inside dialogs and does not compete with autocomplete or disabled fields", async () => {
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
    const wrapper = setup("<<api_url>>", dialog); hoverGeometry(wrapper); await hover(wrapper);
    expect(dialog.querySelector('[role="tooltip"]')).not.toBeNull();
    const input = wrapper.get("input"); input.element.setSelectionRange(5, 5); await input.trigger("focus");
    expect(dialog.querySelector('[role="listbox"]')).not.toBeNull();
    expect(dialog.querySelector('[role="tooltip"]')).toBeNull();
    await hover(wrapper); expect(dialog.querySelector('[role="tooltip"]')).toBeNull();
    await wrapper.setProps({ disabled: true });
    await hover(wrapper); expect(dialog.querySelector('[role="tooltip"]')).toBeNull();
  });
});
