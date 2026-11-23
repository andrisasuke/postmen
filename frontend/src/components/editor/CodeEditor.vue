<script setup lang="ts">
import { markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  EditorState,
  EditorSelection,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  editorTheme as theme,
  codeAppearance,
  jsonHighlighting,
} from "../../services/editor-theme";
import {
  describeJsonDiagnostic,
  formatJsonBody,
  jsonCommentDiagnostics,
  type JsonDiagnostic,
  type JsonDiagnosticDetail,
} from "../../services/json-comments";
import { jsonCommentSupport } from "../../services/json-language";
import {
  EditorView,
  GutterMarker,
  ViewPlugin,
  drawSelection,
  gutterLineClass,
  highlightActiveLine,
  keymap,
  lineNumbers,
  type BlockInfo,
  type ViewUpdate,
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
import { forceLinting, linter } from "@codemirror/lint";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { useSettingsStore } from "../../stores/settings";
import type { RequestView } from "../../types/data";

const setJsonDiagnostics = StateEffect.define<readonly JsonDiagnostic[]>();
const jsonDiagnosticsField = StateField.define<readonly JsonDiagnostic[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setJsonDiagnostics)) return effect.value;
    // Old offsets describe the previous document. Drop them immediately so a
    // red line number never points at the wrong line while lint is pending.
    return transaction.docChanged && value.length > 0 ? [] : value;
  },
});
const jsonErrorGutterMarker = new (class extends GutterMarker {
  elementClass = "cm-json-error-gutter";
})();
const jsonErrorGutterLine = gutterLineClass.compute(
  [jsonDiagnosticsField],
  (state) => {
    const text = state.doc.toString();
    const lines = new Set<number>();
    for (const diagnostic of state.field(jsonDiagnosticsField))
      lines.add(describeJsonDiagnostic(text, diagnostic).line);
    return RangeSet.of(
      [...lines].map((line) =>
        jsonErrorGutterMarker.range(state.doc.line(line).from),
      ),
      true,
    );
  },
);
// Cached tab state reuses these extensions with a new EditorView, so tooltip
// callbacks are looked up per view instead of being captured by the state.
interface JsonErrorHandlers {
  show(view: EditorView, line: BlockInfo, target: EventTarget | null): void;
  hide(): void;
}
interface JsonErrorTip {
  detail: JsonDiagnosticDetail;
  message: string;
  left: number;
  top: number;
  anchorLeft: number;
  anchorTop: number;
}
const jsonErrorHandlers = new WeakMap<EditorView, JsonErrorHandlers>();
const jsonErrorGutterEvents = {
  pointerover(view: EditorView, line: BlockInfo, event: Event) {
    jsonErrorHandlers.get(view)?.show(view, line, event.target);
    return false;
  },
  pointerout(view: EditorView) {
    jsonErrorHandlers.get(view)?.hide();
    return false;
  },
  focusin(view: EditorView, line: BlockInfo, event: Event) {
    jsonErrorHandlers.get(view)?.show(view, line, event.target);
    return false;
  },
  focusout(view: EditorView) {
    jsonErrorHandlers.get(view)?.hide();
    return false;
  },
  keydown(view: EditorView, _line: BlockInfo, event: Event) {
    if (event instanceof KeyboardEvent && event.key === "Escape")
      jsonErrorHandlers.get(view)?.hide();
    return false;
  },
};
// Line number gutters are not focusable by default. Only error numbers gain a
// tab stop so keyboard users can reach the same detail as pointer users.
const jsonErrorGutterFocus = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      view.requestMeasure({
        read: () => null,
        write: () => this.sync(view),
      });
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.startState.field(jsonDiagnosticsField) !==
          update.state.field(jsonDiagnosticsField)
      )
        update.view.requestMeasure({
          read: () => null,
          write: () => this.sync(update.view),
        });
    }
    sync(view: EditorView) {
      for (const element of view.dom.querySelectorAll<HTMLElement>(
        ".cm-lineNumbers .cm-gutterElement.cm-json-error-gutter",
      )) {
        if (element.tabIndex !== 0) element.tabIndex = 0;
        element.setAttribute(
          "aria-label",
          `Line ${element.textContent?.trim() ?? ""}, JSON parse error`,
        );
        element.dataset.jsonError = "true";
      }
      for (const element of view.dom.querySelectorAll<HTMLElement>(
        ".cm-lineNumbers .cm-gutterElement[data-json-error]:not(.cm-json-error-gutter)",
      )) {
        element.removeAttribute("tabindex");
        element.removeAttribute("aria-label");
        delete element.dataset.jsonError;
      }
    }
  },
);

function diagnosticOnLine(state: EditorState, line: number) {
  const text = state.doc.toString();
  return state
    .field(jsonDiagnosticsField)
    .find((diagnostic) => describeJsonDiagnostic(text, diagnostic).line === line);
}

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
const errorTip = ref<JsonErrorTip>();
const tooltip = ref<HTMLElement>();
let editor: EditorView | undefined;
let disposed = false;
function appearance() {
  return codeAppearance(settings.resolvedTheme === "dark");
}
function publishJsonDiagnostics(view: EditorView) {
  view.dispatch({
    effects: setJsonDiagnostics.of(
      jsonCommentDiagnostics(view.state.doc.toString()),
    ),
  });
}
function requestJsonDiagnostics(view: EditorView) {
  const diagnostics = jsonCommentDiagnostics(view.state.doc.toString());
  view.dispatch({ effects: setJsonDiagnostics.of(diagnostics) });
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    severity: "error" as const,
  }));
}
function hideJsonError() {
  if (!errorTip.value) return;
  errorTip.value = undefined;
  editor?.dom
    .querySelectorAll('[aria-describedby="json-error-tooltip"]')
    .forEach((element) => element.removeAttribute("aria-describedby"));
}
function positionJsonError() {
  const element = tooltip.value;
  const current = errorTip.value;
  if (!element || !current) return;
  const margin = 8;
  const gap = 8;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  let left = current.anchorLeft + gap;
  if (left + width > window.innerWidth - margin)
    left = current.anchorLeft - width - gap;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  const top = Math.max(
    margin,
    Math.min(current.anchorTop, window.innerHeight - height - margin),
  );
  errorTip.value = { ...current, left, top };
}
function showJsonError(
  view: EditorView,
  line: BlockInfo,
  target: EventTarget | null,
) {
  const element =
    target instanceof Element
      ? target.closest<HTMLElement>(".cm-lineNumbers .cm-gutterElement")
      : null;
  if (!element || !element.classList.contains("cm-json-error-gutter")) {
    hideJsonError();
    return;
  }
  const diagnostic = diagnosticOnLine(
    view.state,
    view.state.doc.lineAt(line.from).number,
  );
  if (!diagnostic) {
    hideJsonError();
    return;
  }
  const rect = element.getBoundingClientRect();
  errorTip.value = {
    detail: describeJsonDiagnostic(view.state.doc.toString(), diagnostic),
    message: diagnostic.message,
    left: Math.max(8, rect.right + 8),
    top: Math.max(8, rect.top),
    anchorLeft: rect.right,
    anchorTop: rect.top,
  };
  element.setAttribute("aria-describedby", "json-error-tooltip");
  void nextTick(positionJsonError);
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
      jsonCommentSupport(),
      EditorView.lineWrapping,
      history(),
      lineNumbers({ domEventHandlers: jsonErrorGutterEvents }),
      jsonDiagnosticsField,
      jsonErrorGutterLine,
      jsonErrorGutterFocus,
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      indentOnInput(),
      search({ top: true }),
      linter(requestJsonDiagnostics),
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
  hideJsonError();
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
      const docChanged = transactions.some((t) => t.docChanged);
      const diagnosticsChanged = transactions.some((t) =>
        t.effects.some((effect) => effect.is(setJsonDiagnostics)),
      );
      view.update(transactions);
      if (docChanged) {
        const value = view.state.doc.toString();
        if (value !== props.modelValue) emit("update:modelValue", value);
        message.value = "";
        hideJsonError();
      } else if (
        diagnosticsChanged &&
        errorTip.value &&
        !diagnosticOnLine(view.state, errorTip.value.detail.line)
      ) {
        hideJsonError();
      }
      publish();
    },
  });
  jsonErrorHandlers.set(editor, {
    show: showJsonError,
    hide: hideJsonError,
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
      hideJsonError();
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
  hideJsonError();
  saveScroll();
  if (editor) {
    jsonErrorHandlers.delete(editor);
    editor.scrollDOM.removeEventListener("scroll", saveScroll);
    editor.destroy();
  }
  editor = undefined;
});
function format() {
  if (!editor) return;
  try {
    const formatted = formatJsonBody(editor.state.doc.toString());
    if (formatted.unterminated) {
      publishJsonDiagnostics(editor);
      message.value =
        "Unclosed block comment. Close it with */ before formatting. The original body was kept.";
      return;
    }
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
    forceLinting(editor);
    editor.focus();
  } catch {
    publishJsonDiagnostics(editor);
    forceLinting(editor);
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
    <Teleport to="body">
      <div
        v-if="errorTip"
        id="json-error-tooltip"
        ref="tooltip"
        class="json-error-tooltip"
        role="tooltip"
        data-testid="json-error-tooltip"
        :style="{ left: `${errorTip.left}px`, top: `${errorTip.top}px` }"
      >
        <p class="json-error-title">
          Parse error on line {{ errorTip.detail.line }}, column
          {{ errorTip.detail.column }}
        </p>
        <div v-if="errorTip.detail.context" class="json-error-source">
          <div class="json-error-code">{{ errorTip.detail.context }}</div>
          <div class="json-error-code">
            {{ " ".repeat(errorTip.detail.pointer) }}^
          </div>
        </div>
        <p v-else class="json-error-empty">(empty line)</p>
        <p v-if="errorTip.detail.endOfInput" class="json-error-note">
          Error at end of input.
        </p>
        <p class="json-error-message">{{ errorTip.message }}</p>
      </div>
    </Teleport>
  </div>
</template>
