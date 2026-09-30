import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { useSettingsStore } from "../../stores/settings";
import ShellPreview from "./ShellPreview.vue";

const view = vi.hoisted(() => ({ create: vi.fn(), setState: vi.fn(), dispatch: vi.fn(), focus: vi.fn(), destroy: vi.fn() }));
vi.mock("@codemirror/view", async importOriginal => {
  const actual = await importOriginal<typeof import("@codemirror/view")>();
  const MockView = vi.fn(function(options: { state: EditorState }) {
    view.create(options);
    const editor = { state: options.state, dispatch: view.dispatch, focus: view.focus, destroy: view.destroy,
      setState: (state: EditorState) => { editor.state = state; view.setState(state); } };
    return editor;
  });
  Object.setPrototypeOf(MockView, actual.EditorView);
  return { ...actual, EditorView: MockView };
});
let pinia: ReturnType<typeof createPinia>; let wrapper: VueWrapper;
const code = "curl --globoff \\\n  --data-raw 'body\r\nunchanged'";
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  pinia = createPinia(); setActivePinia(pinia);
  wrapper = mount(ShellPreview, { props: { code }, global: { plugins: [pinia] } });
});
afterEach(() => { wrapper.unmount(); disposePinia(pinia); vi.unstubAllGlobals(); });
it("creates a read-only shell syntax document without wrapping or request history", () => {
  const state = view.create.mock.calls[0]![0].state as EditorState;
  expect(state.doc.toString()).toBe(code);
  expect(state.facet(EditorState.readOnly)).toBe(true); expect(state.facet(EditorView.editable)).toBe(false);
  expect(state.facet(EditorView.contentAttributes)).not.toContainEqual({ class: "cm-lineWrapping" });
  expect(syntaxTree(state).toString()).toContain("string");
  expect(state.facet(EditorView.contentAttributes)).toContainEqual({ "aria-label": "Generated cURL code", tabindex: "0" });
});
it("rebuilds only its preview on theme/code changes and selects source for manual copying", async () => {
  useSettingsStore().preferences.theme = "dark"; await flushPromises();
  expect(view.setState).toHaveBeenCalledOnce();
  await wrapper.setProps({ code: "curl --head" });
  expect(view.setState.mock.calls.at(-1)![0].doc.toString()).toBe("curl --head");
  (wrapper.vm as unknown as { selectAll: () => void }).selectAll();
  expect(view.dispatch).toHaveBeenCalledWith({ selection: { anchor: 0, head: "curl --head".length } });
  expect(view.focus).toHaveBeenCalledOnce();
  wrapper.unmount(); expect(view.destroy).toHaveBeenCalledOnce();
});
