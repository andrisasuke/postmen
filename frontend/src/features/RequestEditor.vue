<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue";
import { useWorkspaceStore } from "../stores/workspace";
import { errorMessage } from "../services/data";
import type { HttpMethod } from "../types/shell";
import { methods } from "../types/shell";
import SplitPanes from "../components/layout/SplitPanes.vue";
import UiTabs from "../components/ui/UiTabs.vue";
import UiMenu from "../components/ui/UiMenu.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import VariableInput from "../components/editor/VariableInput.vue";
import UiButton from "../components/ui/UiButton.vue";
import AppIcon from "../components/ui/AppIcon.vue";
import IconButton from "../components/ui/IconButton.vue";
import KeyValueTable from "../components/editor/KeyValueTable.vue";
const CodeEditor = defineAsyncComponent(
  () => import("../components/editor/CodeEditor.vue"),
);
import MultipartEditor from "../components/editor/MultipartEditor.vue";
import ResponsePanel from "./ResponsePanel.vue";
import { useExecutionStore } from "../stores/execution";
import { useRequestQuery } from "../composables/useRequestQuery";
const props = defineProps<{ id: string }>();
const editor = ref<InstanceType<typeof CodeEditor>>();
const store = useWorkspaceStore();
const executions = useExecutionStore();
const running = computed(
  () =>
    executions.states[props.id] &&
    executions.states[props.id]?.phase !== "done",
);
const tab = computed(() => store.tabs[props.id]);
const { url: requestUrl, params: queryParams } = useRequestQuery(() => tab.value?.draft);
const variables = computed(() => store.variablesFor(tab.value?.draft.collectionId ?? null));
const sections = computed(() => [
  {
    id: "params",
    label: "Params",
    count: queryParams.value.filter((r) => r.enabled).length,
  },
  { id: "body", label: "Body" },
  {
    id: "headers",
    label: "Headers",
    count: tab.value?.draft.headers.filter((r) => r.enabled).length ?? 0,
  },
]);
function setSection(id: string) {
  if (id === "params" || id === "body" || id === "headers")
    store.updateView(props.id, { section: id });
}
async function save() {
  try {
    await store.save(props.id);
  } catch (e) {
    store.error = errorMessage(e);
  }
}
function editorAction(id: string) {
  if (id === "undo" || id === "redo") editor.value?.historyAction(id);
  if (id === "search") editor.value?.search();
  if (id === "copy") void editor.value?.copy();
  if (id === "fold") editor.value?.fold();
  if (id === "unfold") editor.value?.unfold();
}
</script>
<template>
  <div v-if="tab" class="request-editor">
    <div class="query-url-wrapper">
      <div class="query-url-input">
        <UiMenu
          label="HTTP method"
          :items="methods.map((id) => ({ id, label: id }))"
          @select="tab.draft.method = $event as HttpMethod"
          ><span
            class="method-label"
            :class="`method-${tab.draft.method.toLowerCase()}`"
            >{{ tab.draft.method }}</span
          >
          <AppIcon name="down" :size="12"
        /></UiMenu>
        <VariableInput
          v-model="requestUrl"
          label="Request URL"
          placeholder="Enter URL or <<api_url>>/path"
          :variables="variables"
        />
        <IconButton
          :label="tab.saving ? 'Saving request' : 'Save request'"
          icon="save"
          :disabled="tab.saving"
          @click="save"
        />
        <UiMenu
          label="Request timeout"
          icon-only
          align="end"
          :items="
            [5, 15, 30, 60, 120].map((seconds) => ({
              id: String(seconds * 1000),
              label: `${seconds} s timeout`,
              checked: executions.timeoutMs === seconds * 1000,
            }))
          "
          @select="executions.timeoutMs = Number($event)"
          ><AppIcon name="settings" :size="14"
        /></UiMenu>
      </div>
      <UiButton
        variant="primary"
        :disabled="
          !executions.ready || store.environmentBusy || executions.states[id]?.phase === 'cancelling'
        "
        :title="
          executions.ready
            ? 'Cmd/Ctrl+Enter'
            : 'HTTP is available in the Tauri desktop app'
        "
        @click="
          running
            ? executions.cancel(id).catch(() => {})
            : executions.send(tab.draft)
        "
        >{{ running ? "Cancel" : "Send" }}</UiButton
      >
    </div>
    <SplitPanes
      ><template #request>
        <div class="pane-toolbar request-toolbar">
          <UiTabs
            label="Request sections"
            :tabs="sections"
            :model-value="tab.view.section"
            @update:model-value="setSection"
          /><span class="spacer" />
          <UiSelect
            v-if="tab.view.section === 'body'"
            v-model="tab.draft.bodyKind"
            label="Body type"
            class="body-kind"
            :options="[
              { value: 'none', label: 'No Body' },
              { value: 'json', label: 'JSON' },
              { value: 'multipart', label: 'Multipart Form' },
            ]"
          />
          <template
            v-if="tab.view.section === 'body' && tab.draft.bodyKind === 'json'"
          >
            <button
              class="prettify-button"
              aria-label="Format JSON"
              @click="editor?.format()"
            >
              Prettify
            </button>
            <UiMenu
              label="JSON editor actions"
              icon-only
              align="end"
              :items="[
                { id: 'search', label: 'Search JSON', shortcut: '⌘/Ctrl+F' },
                { id: 'copy', label: 'Copy JSON' },
                {
                  id: 'undo',
                  label: 'Undo JSON edit',
                  disabled: !editor?.canUndo,
                },
                {
                  id: 'redo',
                  label: 'Redo JSON edit',
                  disabled: !editor?.canRedo,
                },
                { id: 'fold', label: 'Fold JSON' },
                { id: 'unfold', label: 'Unfold JSON' },
              ]"
              @select="editorAction"
              ><AppIcon name="dots" :size="14"
            /></UiMenu>
          </template>
        </div>
        <div v-if="tab.view.section === 'params'" class="request-table">
          <h3>Query</h3>
          <KeyValueTable
            v-model="queryParams"
            label="Query parameters"
            :variables="variables"
            editable
          />
        </div>
        <div v-else-if="tab.view.section === 'headers'" class="request-table">
          <h3>Headers</h3>
          <KeyValueTable
            v-model="tab.draft.headers"
            label="Request headers"
            :variables="variables"
            header-autocomplete
            editable
          />
        </div>
        <CodeEditor
          ref="editor"
          v-else-if="tab.draft.bodyKind === 'json'"
          :model-value="tab.draft.body"
          :state="tab.editorState"
          :selection="tab.view.selection"
          :scroll="tab.view.scroll"
          @update:model-value="tab.draft.body = $event"
          @state="store.cacheEditor(id, $event)"
          @selection="store.updateView(id, { selection: $event })"
          @scroll="store.updateView(id, { scroll: $event })"
        />
        <MultipartEditor
          v-else-if="tab.draft.bodyKind === 'multipart'"
          v-model="tab.draft.formData"
        />
        <div v-else class="response-empty">
          <AppIcon name="file" :size="32" />
          <p>This request has no body.</p>
          <UiButton @click="tab.draft.bodyKind = 'json'"
            >Use JSON body</UiButton
          >
        </div> </template
      ><template #response> <ResponsePanel :id="id" /> </template
    ></SplitPanes>
  </div>
</template>
