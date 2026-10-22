import { afterEach, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compileStyle, parse } from "@vue/compiler-sfc";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeAppearance } from "../services/editor-theme";
import dialogSource from "./GenerateCodeDialog.vue?raw";
import editorSource from "./RequestEditor.vue?raw";

function componentCss(source: string, filename: string) {
  return parse(source, { filename }).descriptor.styles.map(style => {
    const result = compileStyle({ source: style.content, filename, id: "focus-regression", scoped: style.scoped });
    expect(result.errors).toEqual([]);
    return result.code;
  }).join("\n");
}
// Vitest mocks CSS imports by default, including ?raw CSS in this setup.
const globalCss = ["../styles/app.css", "../styles/workspace.css"]
  .map(path => readFileSync(new URL(path, import.meta.url), "utf8"));
const featureCss = [componentCss(dialogSource, "GenerateCodeDialog.vue"), componentCss(editorSource, "RequestEditor.vue")];
type Specificity = [number, number, number];
const compare = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i++) {
    const difference = a[i]! - b[i]!;
    if (difference) return difference;
  }
  return 0;
};
function specificity(selector: selectorParser.Selector): Specificity {
  const score: Specificity = [0, 0, 0];
  for (const node of selector.nodes) {
    if (node.type === "id") score[0]++;
    else if (node.type === "class" || node.type === "attribute") score[1]++;
    else if (node.type === "tag") score[2]++;
    else if (node.type === "pseudo") {
      if (node.value.startsWith("::")) score[2]++;
      else if (node.nodes?.length) {
        // Only :not() occurs in the matching application rules. Fail loudly
        // if another functional pseudo needs specificity support later.
        expect(node.value).toBe(":not");
        const nested = node.nodes.map(specificity).sort(compare).at(-1)!;
        for (let i = 0; i < 3; i++) score[i]! += nested[i]!;
      } else score[1]++;
    }
  }
  return score;
}

// jsdom does not fully implement browser focus-visible heuristics or CSS
// specificity. Resolve actual compiled declarations deterministically using
// selector matching, specificity and source order, with explicit focus state.
function resolved(element: Element, property: string, sheets: string[]) {
  let winner: { value: string; priority: number[] } | undefined;
  let order = 0;
  for (const css of sheets) postcss.parse(css).walkRules(rule => {
    const declarations = rule.nodes.filter(node => node.type === "decl" && node.prop === property);
    if (!declarations.length) return;
    for (const selector of selectorParser().astSync(rule.selector).nodes) {
      const matchSelector = selector.toString()
        .replace(/:focus-visible\b/g, "[data-test-focus-visible]")
        .replace(/:focus(?![\w-])/g, "[data-test-focus]")
        .replace(/:hover\b/g, "[data-test-hover]");
      if (!element.matches(matchSelector)) continue;
      for (const declaration of declarations) {
        if (declaration.type !== "decl") continue;
        const priority = [Number(declaration.important ?? false), ...specificity(selector), order++];
        if (!winner || compare(priority, winner.priority) >= 0)
          winner = { value: declaration.value, priority };
      }
    }
  });
  return winner?.value ?? "";
}
const get = (selector: string) => document.querySelector<HTMLElement>(selector)!;
function focus(element: HTMLElement, visible = true) {
  document.querySelectorAll('[data-test-focus], [data-test-focus-visible]').forEach(node => {
    node.removeAttribute("data-test-focus"); node.removeAttribute("data-test-focus-visible");
  });
  element.focus();
  element.setAttribute("data-test-focus", "");
  if (visible) element.setAttribute("data-test-focus-visible", "");
}
beforeEach(() => {
  document.body.innerHTML = `
    <button class="icon-button generate-code-button" id="opener">Generate</button>
    <div class="ui-modal generate-code-dialog" tabindex="-1" id="panel">
      <button class="icon-button" id="x">X</button>
      <div class="generate-code-preview" id="area">
        <button class="icon-button generate-code-copy" id="copy">Copy</button>
        <div class="shell-preview">
          <div class="cm-editor cm-focused" tabindex="-1" id="preview">
            <div class="cm-gutters" id="gutters">1</div>
            <div class="cm-content" contenteditable="false" tabindex="0" id="content">Synthetic code</div>
            <div class="cm-selectionBackground" id="selection"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="cm-editor" id="other-editor"><div class="cm-gutters" id="other-gutters">1</div></div>
    <div class="ui-modal" tabindex="-1" id="other-modal"><button id="other-x">X</button></div>
    <input id="other-input" />
    <button class="icon-button save-request-button save-request-dirty" id="save">Save</button>`;
});
afterEach(() => document.body.replaceChildren());

it("reproduces the global outline on panel and opener without the feature override", () => {
  for (const selector of ["#panel", "#opener"]) {
    const element = get(selector); focus(element);
    expect(resolved(element, "outline", globalCss)).toBe("1px solid var(--primary)");
  }
});

it.each([
  { visible: false, globalLast: false }, { visible: true, globalLast: false },
  { visible: false, globalLast: true }, { visible: true, globalLast: true },
])("removes Generate outlines with focus-visible=$visible and global CSS last=$globalLast", ({ visible, globalLast }) => {
  const sheets = globalLast ? [...featureCss, ...globalCss] : [...globalCss, ...featureCss];
  for (const selector of ["#panel", "#opener", "#x", "#copy", "#preview", "#content"]) {
    const element = get(selector);
    const border = resolved(element, "border", sheets);
    const borderColor = resolved(element, "border-color", sheets);
    const shadow = resolved(element, "box-shadow", sheets) || "none";
    focus(element, visible);
    expect(resolved(element, "outline", sheets), selector).toBe("none");
    expect(resolved(element, "border", sheets), selector).toBe(border);
    expect(resolved(element, "border-color", sheets), selector).toBe(borderColor);
    expect(resolved(element, "box-shadow", sheets) || "none", selector).toBe(shadow);
  }
  expect(resolved(get("#panel"), "border", sheets)).toBe("1px solid var(--border-subtle)");
  expect(resolved(get("#panel"), "box-shadow", sheets)).toBe("0 2px 12px rgb(0 0 0 / 15%)");
});

it("keeps global focus outlines on unrelated controls and dialogs", () => {
  const sheets = [...globalCss, ...featureCss];
  for (const selector of ["#other-modal", "#other-x", "#other-input", "#save"]) {
    const element = get(selector); focus(element);
    expect(resolved(element, "outline", sheets), selector).toBe("1px solid var(--primary)");
  }
});

it("keeps normal hover colors and Save dirty color while removing the Generate ring", () => {
  const sheets = [...globalCss, ...featureCss];
  for (const selector of ["#opener", "#x", "#copy"]) {
    const element = get(selector); focus(element); element.setAttribute("data-test-hover", "");
    expect(resolved(element, "background", sheets)).toBe("var(--hover)");
    expect(resolved(element, "color", sheets)).toBe("var(--text)");
    expect(resolved(element, "outline", sheets)).toBe("none");
  }
  const save = get("#save"); focus(save); save.setAttribute("data-test-hover", "");
  expect(resolved(save, "color", sheets)).toBe("var(--primary-text)");
  save.classList.remove("save-request-dirty");
  expect(resolved(save, "color", sheets)).toBe("var(--muted)");
});

it.each([false, true])("blends only the Generate editor and gutters into the dialog with dark=$dark", dark => {
  // Include actual generated CodeMirror theme CSS instead of approximating its
  // selectors. This exercises the cascade against the shared editor theme.
  const state = EditorState.create({ extensions: [codeAppearance(dark)] });
  const themeCss = state.facet(EditorView.styleModule).map(module => module.getRules()).join("\n");
  const rootSelector = postcss.parse(themeCss).nodes.find(node => node.type === "rule")!;
  if (rootSelector.type !== "rule") throw new Error("Missing CodeMirror root selector");
  const themeClass = rootSelector.selector.slice(1);
  get("#preview").classList.add(themeClass);
  get("#other-editor").classList.add(themeClass);
  for (const sheets of [
    [...globalCss, themeCss, ...featureCss], [...featureCss, ...globalCss, themeCss],
  ]) {
    const preview = get("#preview"); focus(preview);
    expect(resolved(get("#area"), "background", sheets)).toBe("transparent");
    expect(resolved(preview, "background-color", sheets)).toBe("transparent");
    expect(resolved(preview, "border", sheets)).toBe("none");
    expect(resolved(preview, "outline", sheets)).toBe("none");
    expect(resolved(preview, "box-shadow", sheets)).toBe("none");
    expect(resolved(get("#gutters"), "background-color", sheets)).toBe("var(--modal-bg)");
    expect(resolved(get("#gutters"), "border", sheets)).toBe("none");
    expect(resolved(get("#selection"), "background-color", sheets)).toBe("var(--hover)");
    expect(resolved(get("#other-editor"), "background-color", sheets)).toBe("var(--bg)");
    expect(resolved(get("#other-editor"), "border", sheets)).toBe("1px solid var(--bg)");
    expect(resolved(get("#other-gutters"), "background-color", sheets)).toBe("var(--bg)");
    expect(resolved(get("#panel"), "background", sheets)).toBe("var(--modal-bg)");
    expect(resolved(get("#panel"), "border", sheets)).toBe("1px solid var(--border-subtle)");
    expect(resolved(get("#panel"), "box-shadow", sheets)).toBe("0 2px 12px rgb(0 0 0 / 15%)");
  }
});

it("keeps the success check green on hover/focus without adding a ring", () => {
  const button = get("#copy"); button.classList.add("generate-code-copied"); focus(button);
  for (const sheets of [[...globalCss, ...featureCss], [...featureCss, ...globalCss]]) {
    expect(resolved(button, "color", sheets)).toBe("var(--toast-success)");
    button.setAttribute("data-test-hover", "");
    expect(resolved(button, "color", sheets)).toBe("var(--toast-success)");
    expect(resolved(button, "background", sheets)).toBe("var(--hover)");
    expect(resolved(button, "outline", sheets)).toBe("none");
    expect(resolved(button, "box-shadow", sheets)).toBe("none");
    button.removeAttribute("data-test-hover");
  }
});
