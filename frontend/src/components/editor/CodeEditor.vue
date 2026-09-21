<script setup lang="ts">
import { markRaw, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorState, EditorSelection } from "@codemirror/state";
import {
  editorTheme as theme,
  codeAppearance,
  jsonHighlighting,
} from "../../services/editor-theme";
import { formatResponse } from "../../services/response-format";
import {
  EditorView,
  lineNumbers,
  keymap,
  drawSelection,
  highlightActiveLine,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
  undoDepth,
  redoDepth,
  isolateHistory,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap,
  foldAll,
  unfoldAll,
} from "@codemirror/language";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter } from "@codemirror/lint";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { useSettingsStore } from "../../stores/settings";
import type { RequestView } from "../../types/data";

const props = defineProps<{
  modelValue: string;
  state: EditorState | null;
  selection: RequestView["selection"];
  scroll: RequestView["scroll"];
}>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  state: [value: EditorState];
  selection: [value: RequestView["selection"]];
  scroll: [value: RequestView["scroll"]];
}>();
const host = ref<HTMLElement>();
const settings = useSettingsStore();
const message = ref("");
const canUndo = ref(false);
const canRedo = ref(false);
let editor: EditorView | undefined;
let disposed = false;
function appearance() {
  return codeAppearance(settings.resolvedTheme === "dark");
}
function freshState() {
  const length = props.modelValue.length;
  return EditorState.create({
    doc: props.modelValue,
    selection: EditorSelection.single(
      Math.min(props.selection.anchor, length),
      Math.min(props.selection.head, length),
    ),
    extensions: [
      json(),
      EditorView.lineWrapping,
      history(),
      lineNumbers(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      indentOnInput(),
      search({ top: true }),
      linter(jsonParseLinter()),
      foldGutter({ openText: "▾", closedText: "▸" }),
      jsonHighlighting,
      EditorState.tabSize.of(2),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      theme.of(appearance()),
      EditorView.contentAttributes.of({
        "aria-label": "JSON request body",
        "data-testid": "json-editor-input",
      }),
    ],
  });
}
function publish() {
  if (!editor) return;
  const state = editor.state;
  canUndo.value = undoDepth(state) > 0;
  canRedo.value = redoDepth(state) > 0;
  emit("state", markRaw(state));
  const selection = state.selection.main;
  emit("selection", { anchor: selection.anchor, head: selection.head });
}
function saveScroll() {
  if (editor)
    emit("scroll", {
      top: editor.scrollDOM.scrollTop,
      left: editor.scrollDOM.scrollLeft,
    });
}
onMounted(() => {
  if (!host.value) return;
  editor = new EditorView({
    parent: host.value,
    state: props.state ?? freshState(),
    dispatchTransactions(transactions, view) {
      view.update(transactions);
      if (transactions.some((t) => t.docChanged)) {
        const value = view.state.doc.toString();
        if (value !== props.modelValue) emit("update:modelValue", value);
        message.value = "";
      }
      publish();
    },
  });
  // Reconfigure the shared compartment when reopening cached state after a
  // theme change. Its document, selection and undo history remain intact.
  editor.dispatch({ effects: theme.reconfigure(appearance()) });
  editor.scrollDOM.addEventListener("scroll", saveScroll);
  const position = { ...props.scroll };
  requestAnimationFrame(() => {
    if (editor && !disposed) {
      editor.scrollDOM.scrollTo(position.left, position.top);
      publish();
    }
  });
});
watch(
  () => props.modelValue,
  (value) => {
    if (editor && value !== editor.state.doc.toString())
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
      });
  },
);
watch(
  () => props.state,
  (state) => {
    if (state === null && editor) {
      editor.setState(freshState());
      publish();
    }
  },
);
watch(
  () => settings.resolvedTheme,
  () => {
    if (editor) editor.dispatch({ effects: theme.reconfigure(appearance()) });
  },
);
onBeforeUnmount(() => {
  disposed = true;
  saveScroll();
  editor?.scrollDOM.removeEventListener("scroll", saveScroll);
  editor?.destroy();
  editor = undefined;
});
function format() {
  if (!editor) return;
  try {
    const formatted = formatResponse(editor.state.doc.toString());
    if (formatted.limited) {
      message.value =
        "Formatting safety limit reached. The original body was kept.";
      return;
    }
    if (!formatted.json) throw new Error("Invalid JSON");
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: formatted.body },
      annotations: isolateHistory.of("full"),
    });
    editor.focus();
  } catch {
    message.value =
      "Invalid JSON. Fix the highlighted syntax errors before formatting. You can still save this body.";
  }
}
function historyAction(action: "undo" | "redo") {
  if (editor) {
    (action === "undo" ? undo : redo)(editor);
    editor.focus();
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(
      editor?.state.doc.toString() ?? props.modelValue,
    );
    message.value = "JSON copied.";
  } catch {
    message.value =
      "Clipboard unavailable. Select the JSON and use Cmd/Ctrl+C.";
  }
}
defineExpose({
  format,
  copy,
  canUndo,
  canRedo,
  historyAction,
  search: () => editor && openSearchPanel(editor),
  fold: () => editor && foldAll(editor),
  unfold: () => editor && unfoldAll(editor),
});
</script>
<template>
  <div class="json-editor" data-testid="json-editor">
    <p v-if="message" class="editor-message" role="status">{{ message }}</p>
    <div ref="host" class="codemirror-host" />
  </div>
</template>
