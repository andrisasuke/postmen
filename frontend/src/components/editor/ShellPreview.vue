<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, lineNumbers } from "@codemirror/view";
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { tags } from "@lezer/highlight";
import { codeAppearance } from "../../services/editor-theme";
import { useSettingsStore } from "../../stores/settings";

const props = defineProps<{ code: string }>();
const settings = useSettingsStore();
const host = ref<HTMLElement>();
let editor: EditorView | undefined;
function state() {
  return EditorState.create({
    doc: props.code,
    extensions: [
      EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), drawSelection(),
      EditorState.lineSeparator.of("\n"),
      StreamLanguage.define(shell),
      syntaxHighlighting(HighlightStyle.define([
        { tag: tags.string, color: "var(--syntax-string)" },
        { tag: [tags.keyword, tags.operator, tags.standard(tags.name)], color: "var(--syntax-property)" },
        { tag: tags.number, color: "var(--syntax-number)" },
        { tag: tags.comment, color: "var(--muted)" },
      ])),
      EditorView.contentAttributes.of({ "aria-label": "Generated cURL code", tabindex: "0" }),
      codeAppearance(settings.resolvedTheme === "dark"),
    ],
  });
}
onMounted(() => {
  if (host.value) editor = new EditorView({ parent: host.value, state: state() });
});
watch(() => [props.code, settings.resolvedTheme], () => editor?.setState(state()));
onBeforeUnmount(() => editor?.destroy());
defineExpose({ selectAll: () => {
  editor?.dispatch({ selection: { anchor: 0, head: editor.state.doc.length } });
  editor?.focus();
} });
</script>
<template><div ref="host" class="shell-preview codemirror-host" /></template>
