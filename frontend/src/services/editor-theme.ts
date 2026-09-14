import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
// Shared identity allows cached tab EditorStates to reconfigure their theme
// after the Vue component owning the previous EditorView has been unmounted.
export const editorTheme = new Compartment();
export const jsonHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "var(--syntax-property)" },
    { tag: tags.string, color: "var(--syntax-string)" },
    { tag: [tags.bool, tags.null], color: "var(--syntax-atom)" },
    { tag: tags.number, color: "var(--syntax-number)" },
    { tag: tags.punctuation, color: "var(--code-text)" },
  ]),
);
export function codeAppearance(dark: boolean) {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: "var(--bg)",
        color: "var(--code-text)",
        border: "1px solid var(--bg)",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-code)",
        fontSize: "13px",
        lineHeight: "19.5px",
        overflow: "auto",
      },
      ".cm-content": { padding: "4px 0 24px", caretColor: "var(--text)" },
      ".cm-line": { padding: "0 4px" },
      ".cm-gutters": {
        backgroundColor: "var(--bg)",
        color: "var(--code-gutter)",
        border: "none",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 3px",
        minWidth: "24px",
        textAlign: "left",
      },
      ".cm-foldGutter .cm-gutterElement": {
        padding: "0",
        width: "13px",
        textAlign: "center",
        cursor: "pointer",
      },
      ".cm-activeLine,.cm-activeLineGutter": { backgroundColor: "transparent" },
      ".cm-cursor": { borderLeftColor: "var(--text)" },
      "&.cm-focused .cm-selectionBackground,.cm-selectionBackground": {
        backgroundColor: "var(--hover)",
      },
      ".cm-panels,.cm-tooltip": {
        backgroundColor: "var(--menu-bg)",
        color: "var(--text)",
        borderColor: "var(--border)",
      },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in srgb, var(--primary) 28%, transparent)",
      },
    },
    { dark },
  );
}
