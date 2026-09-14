<script setup lang="ts">
import {
  computed,
  nextTick,
  onErrorCaptured,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import {
  bootstrapDesktop,
  isDesktop,
  onShellAction,
  setWindowTheme,
} from "../services/desktop";
import { errorMessage, nativeDataApi } from "../services/data";
import { useWorkspaceStore } from "../stores/workspace";
import { useWorkspacesStore } from "../stores/workspaces";
import WorkspaceSelector from "../features/WorkspaceSelector.vue";
import WorkspaceNameForm from "../features/WorkspaceNameForm.vue";
import WorkspaceManager from "../features/WorkspaceManager.vue";
import { useSettingsStore } from "../stores/settings";
import { useViewport } from "../composables/useViewport";
import type { BootstrapInfo, ShellAction } from "../types/shell";
import type { Parent, TreeRef } from "../types/data";
import TitleBar from "../components/layout/TitleBar.vue";
import WorkspaceSidebar from "../components/layout/WorkspaceSidebar.vue";
import WorkspaceOverview from "../components/layout/WorkspaceOverview.vue";
import StatusBar from "../components/layout/StatusBar.vue";
import RequestEditor from "../features/RequestEditor.vue";
import CreateRequestDialog from "../features/CreateRequestDialog.vue";
import CreateFolderDialog from "../features/CreateFolderDialog.vue";
import ImportCollectionDialog from "../features/ImportCollectionDialog.vue";
import ExportCollectionDialog from "../features/ExportCollectionDialog.vue";
import CloneRequestDialog from "../features/CloneRequestDialog.vue";
import RenameItemDialog from "../features/RenameItemDialog.vue";
import EnvironmentSelector from "../features/EnvironmentSelector.vue";
import EnvironmentManager from "../features/EnvironmentManager.vue";
import QuitDialog from "../features/QuitDialog.vue";
import { useExecutionStore } from "../stores/execution";
import { nativeExecutionApi, closeGuardReady } from "../services/execution";
import UiModal from "../components/ui/UiModal.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiMenu from "../components/ui/UiMenu.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import IconButton from "../components/ui/IconButton.vue";
import AppIcon from "../components/ui/AppIcon.vue";
import ToastHost from "../components/ui/ToastHost.vue";

const store = useWorkspaceStore();
const workspaces = useWorkspacesStore();
const executions = useExecutionStore();
const quitOpen = ref(false);
const fixtureClosed = ref(false);
const development = import.meta.env.DEV;
const fixtureNotice = import.meta.env.DEV
  ? "Development fixture — browser storage only, no SQLite; HTTP simulations only in execution fixture. Do not enter real credentials."
  : "";
const settings = useSettingsStore();
const { width } = useViewport();
const info = ref<BootstrapInfo | null>(null);
const connection = ref<
  "loading" | "connected" | "browser" | "fixture" | "error"
>("loading");
const about = ref(false);
const environmentScope = ref<"collection" | "global" | null>(null);
const creating = ref<Parent | null>(null);
const creatingFolder = ref<Parent | null>(null);
const importing = ref(false);
const exporting = ref(false);
const cloning = ref<string | null>(null);
const renaming = ref<TreeRef | null>(null);
const fatal = ref(false);
const compact = ref(false);
const sidebar = ref<InstanceType<typeof WorkspaceSidebar>>();
const pendingClose = ref<string | null>(null);
const deleting = ref<TreeRef | null>(null);
const moving = ref<TreeRef | null>(null);
const destination = ref<string | null>(null);
const reloading = ref<string | null>(null);
const modalError = ref("");
const busy = ref(false);
const draggingTab = ref<string | null>(null);
const tabMenu = ref<InstanceType<typeof UiMenu>>();
const tabContext = ref<string | null>(null);
const visible = computed(() =>
  width.value < 940 ? compact.value : !settings.preferences.sidebarCollapsed,
);
const platform = computed(
  () =>
    info.value?.platform ??
    (/Mac/.test(navigator.platform) ? "macos" : "other"),
);
const connectionLabel = computed(
  () =>
    ({
      loading: "Opening workspace…",
      connected: "Tauri",
      browser: "Browser preview",
      fixture: "Browser fixture · no SQLite",
      error: "Storage unavailable",
    })[connection.value],
);
const collectionName = computed(
  () =>
    store.active
      ? store.data.collections.find((c) => c.id === store.activeCollectionId)?.name ?? workspaces.activeName
      : workspaces.activeName,
);
const selectedName = (item: TreeRef | null) =>
  !item
    ? ""
    : item.kind === "collection"
      ? store.data.collections.find((c) => c.id === item.id)?.name
      : item.kind === "folder"
        ? store.data.folders.find((f) => f.id === item.id)?.name
        : (store.tabs[item.id]?.draft.name ??
          store.data.requests.find((r) => r.id === item.id)?.name);
const modalOpen = computed(
  () =>
    quitOpen.value ||
    workspaces.creating ||
    workspaces.busy ||
    workspaces.needsRecovery ||
    workspaces.deletingId !== null ||
    about.value ||
    environmentScope.value !== null ||
    creating.value !== null ||
    creatingFolder.value !== null ||
    importing.value ||
    exporting.value ||
    cloning.value !== null ||
    renaming.value !== null ||
    pendingClose.value !== null ||
    deleting.value !== null ||
    moving.value !== null ||
    reloading.value !== null,
);
const workspaceSelectionDisabled = computed(() => modalOpen.value || !store.ready || store.loading
  || store.pendingOperations > 0 || store.environmentBusy || !!sidebar.value?.hasPendingInput);
async function changeWorkspace(id?: string) {
  if (id && workspaceSelectionDisabled.value) return;
  if (await workspaces.change(id)) compact.value = false;
}
function manageWorkspaces() {
  if (workspaceSelectionDisabled.value) return;
  workspaces.failure = "";
  workspaces.managing = true;
}
function home() {
  if (modalOpen.value) return;
  workspaces.managing = false;
  store.activate(null);
}
const moveFolders = computed(() => {
  const item = moving.value;
  if (!item) return [];
  const source =
    item.kind === "folder"
      ? store.data.folders.find((f) => f.id === item.id)
      : store.data.requests.find((r) => r.id === item.id);
  if (!source) return [];
  return store.data.folders.filter((f) => {
    if (f.collectionId !== source.collectionId) return false;
    if (item.kind !== "folder") return true;
    let cursor: string | null = f.id;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      if (cursor === item.id) return false;
      visited.add(cursor);
      cursor =
        store.data.folders.find((x) => x.id === cursor)?.parentId ?? null;
    }
    return true;
  });
});
function toggleSidebar() {
  if (width.value < 940) compact.value = !compact.value;
  else
    settings.preferences.sidebarCollapsed =
      !settings.preferences.sidebarCollapsed;
}
async function withSidebar(
  action: (value: InstanceType<typeof WorkspaceSidebar>) => unknown,
) {
  if (!visible.value) {
    if (width.value < 940) compact.value = true;
    else settings.preferences.sidebarCollapsed = false;
    await nextTick();
  }
  if (sidebar.value) action(sidebar.value);
}
function createCollection() {
  void withSidebar((value) => value.createCollection());
}
function createRequest(
  collectionId = store.selectedCollectionId ?? store.activeCollectionId,
) {
  if (!collectionId) {
    createCollection();
    return;
  }
  if (!modalOpen.value) creating.value = { collectionId, parentId: null };
}
function requestCreated(id: string) {
  creating.value = null;
  void open(id);
}
async function open(id: string) {
  try {
    await store.open(id);
    workspaces.managing = false;
    compact.value = false;
  } catch (e) {
    store.error = errorMessage(e);
  }
}
async function connect() {
  if (store.loading) return;
  connection.value = "loading";
  store.error = "";
  try {
    if (
      import.meta.env.DEV &&
      new URLSearchParams(location.search).get("fixture") === "visual"
    ) {
      const { createVisualFixture } = await import("../fixtures/visual-api");
      const fixture = await createVisualFixture(
        new URLSearchParams(location.search).has("empty"),
      );
      await store.initialize(fixture.data);
      executions.initialize(fixture.execution);
      connection.value = "fixture";
      return;
    }
    if (
      import.meta.env.DEV &&
      ["workspace", "execution"].includes(
        new URLSearchParams(location.search).get("fixture") ?? "",
      )
    ) {
      const { createMemoryApi } = await import("../fixtures/memory-api");
      await store.initialize(createMemoryApi(true));
      connection.value = "fixture";
      if (new URLSearchParams(location.search).get("fixture") === "execution") {
        const { createExecutionFixture } = await import(
          "../fixtures/execution-api"
        );
        executions.initialize(createExecutionFixture());
      }

      return;
    }
    info.value = await bootstrapDesktop();
    if (info.value) {
      await workspaces.initialize();
      await store.initialize(nativeDataApi);
      executions.initialize(nativeExecutionApi);
      connection.value = "connected";
    } else connection.value = "browser";
  } catch (e) {
    connection.value = "error";
    store.error = errorMessage(e);
  }
}
async function close(id: string) {
  if (store.tabs[id]?.saving) {
    store.error = "Wait for the save to finish before closing this tab.";
    return;
  }
  modalError.value = "";
  if (store.dirty(id)) pendingClose.value = id;
  else {
    try {
      await executions.forget(id);
      store.closeClean(id);
    } catch (e) {
      store.error = errorMessage(e);
    }
  }
}
async function resolveClose(save: boolean) {
  const id = pendingClose.value;
  if (!id || busy.value) return;
  busy.value = true;
  modalError.value = "";
  try {
    if (save) {
      if (!(await store.save(id))) {
        modalError.value =
          "This request still has unsaved changes. Save again or discard them.";
        return;
      }
    } else store.discard(id);
    await executions.forget(id);
    if (store.closeClean(id)) pendingClose.value = null;
  } catch (e) {
    modalError.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function deleteItem() {
  if (!deleting.value || busy.value) return;
  busy.value = true;
  modalError.value = "";
  try {
    for (const id of store.descendants(deleting.value))
      await executions.forget(id);
    await store.remove(deleting.value);
    deleting.value = null;
  } catch (e) {
    modalError.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
function askMove(item: TreeRef) {
  moving.value = item;
  destination.value = null;
  modalError.value = "";
}
async function moveItem() {
  if (!moving.value) return;
  busy.value = true;
  modalError.value = "";
  try {
    await store.moveToFolder(moving.value, destination.value);
    moving.value = null;
  } catch (e) {
    modalError.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function reloadRequest() {
  if (!reloading.value) return;
  busy.value = true;
  modalError.value = "";
  try {
    await store.reloadSaved(reloading.value);
    reloading.value = null;
  } catch (e) {
    modalError.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function action(value: ShellAction) {
  if (value === "request-quit") {
    if (workspaces.creating || workspaces.busy || workspaces.needsRecovery) {
      store.error = "Confirm or cancel workspace creation, then quit again.";
      return;
    }
    if (document.querySelector('[role="dialog"]') && !quitOpen.value) {
      store.error = "Finish or cancel the current dialog, then quit again.";
      return;
    }
    quitOpen.value = true;
    return;
  }
  if (modalOpen.value || workspaces.managing) return;
  if (value === "send-request" && store.active && !store.environmentBusy)
    void executions.send(store.active.draft);
  if (value === "about") about.value = true;
  if (value === "toggle-sidebar") toggleSidebar();
  if (value === "toggle-layout") settings.toggleLayout();
  if (value === "reset-layout") settings.resetLayout();
  if (value === "close-request" && store.activeId) close(store.activeId);
  if (value === "next-request") store.nextTab(1);
  if (value === "previous-request") store.nextTab(-1);
  if (value === "save-request" && store.activeId) {
    try {
      await store.save(store.activeId);
    } catch (e) {
      store.error = errorMessage(e);
    }
  }
}
function shortcuts(event: KeyboardEvent) {
  if (event.key === "Escape" && compact.value && !modalOpen.value) {
    compact.value = false;
    return;
  }
  if (modalOpen.value || workspaces.managing || !(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (key === "enter") {
    event.preventDefault();
    if (!isDesktop() && store.active) void executions.send(store.active.draft);
    return;
  }
  if (!isDesktop()) {
    const command: ShellAction | undefined =
      key === "q"
        ? "request-quit"
        : key === "s"
          ? "save-request"
          : key === "w"
            ? "close-request"
            : key === "tab"
              ? event.shiftKey
                ? "previous-request"
                : "next-request"
              : key === "b"
                ? "toggle-sidebar"
                : key === "l" && event.shiftKey
                  ? "toggle-layout"
                  : undefined;
    if (command) {
      event.preventDefault();
      void action(command);
    }
  }
}
function unload(event: BeforeUnloadEvent) {
  if (!isDesktop() && store.hasDirty && !fixtureClosed.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
function tabKey(event: KeyboardEvent) {
  if (
    !(event.target instanceof HTMLElement) ||
    event.target.getAttribute("role") !== "tab"
  )
    return;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index = store.tabIds.indexOf(store.activeId ?? "");
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? store.tabIds.length - 1
        : (index + (event.key === "ArrowLeft" ? -1 : 1) + store.tabIds.length) %
          store.tabIds.length;
  const id = store.tabIds[next];
  if (id) {
    store.activate(id);
    void nextTick(() =>
      document
        .querySelector<HTMLElement>(`[data-request-tab="${id}"]`)
        ?.focus(),
    );
  }
}
function dropTab(event: DragEvent, id: string) {
  event.preventDefault();
  const source = draggingTab.value;
  draggingTab.value = null;
  if (!source || source === id) return;
  const ids = store.tabIds.filter((x) => x !== source);
  ids.splice(ids.indexOf(id), 0, source);
  store.reorderTabs(ids);
}
function tabContextMenu(event: MouseEvent, id: string) {
  event.preventDefault();
  tabContext.value = id;
  void tabMenu.value?.openAt(
    event.clientX,
    event.clientY,
    event.currentTarget as HTMLElement,
  );
}
function tabAction(value: string) {
  const id = tabContext.value;
  if (!id) return;
  if (value === "close") close(id);
  else if (value === "reload") {
    reloading.value = id;
    modalError.value = "";
  } else {
    const ids = [...store.tabIds];
    const index = ids.indexOf(id);
    const target = index + (value === "left" ? -1 : 1);
    if (target < 0 || target >= ids.length) return;
    ids.splice(index, 1);
    ids.splice(target, 0, id);
    store.reorderTabs(ids);
  }
}
watch(
  () => settings.preferences.theme,
  async (theme) => {
    try {
      await setWindowTheme(theme);
    } catch {
      store.error = "The native window theme could not be updated.";
    }
  },
  { immediate: true },
);
onErrorCaptured(() => {
  fatal.value = true;
  store.error =
    "This screen failed unexpectedly. Restart the application to recover; saved requests remain in the new database.";
  return false;
});
let unlisten: (() => void) | undefined;
let disposed = false;
onMounted(async () => {
  window.addEventListener("keydown", shortcuts);
  window.addEventListener("beforeunload", unload);
  void connect();
  try {
    const remove = await onShellAction((value) => {
      void action(value);
    });
    if (disposed) remove();
    else {
      unlisten = remove;
      if (isDesktop()) await closeGuardReady();
    }
  } catch {
    store.error = "Native menu actions could not be connected.";
  }
});
onUnmounted(() => {
  disposed = true;
  unlisten?.();
  window.removeEventListener("keydown", shortcuts);
  window.removeEventListener("beforeunload", unload);
});
</script>
<template>
  <div
    class="app-shell"
    :data-connection="connection"
    :data-fixture="connection === 'fixture'"
    :data-ready="store.ready"
    :data-closed="fixtureClosed"
    data-testid="app-shell"
  >
    <TitleBar
      :platform="platform"
      :has-request="!!store.active"
      :sidebar-visible="visible"
      @toggle-sidebar="toggleSidebar"
      @home="home"
      @error="store.error = $event"
    >
      <template #workspace>
        <WorkspaceSelector :disabled="workspaceSelectionDisabled" @create="workspaces.beginCreate" @manage="manageWorkspaces" @select="changeWorkspace" />
      </template>
    </TitleBar>
    <div v-if="fatal" class="fatal-state" role="alert">
      <h1>Unable to display this screen</h1>
      <p>{{ store.error }}</p>
    </div>
    <div v-else class="app-main">
      <button
        v-if="width < 940 && visible"
        class="sidebar-backdrop"
        aria-label="Close collection sidebar"
        @click="compact = false"
      />
      <WorkspaceSidebar
        v-if="visible"
        :key="workspaces.catalog?.activeId ?? 'default'"
        ref="sidebar"
        :creating-workspace="workspaces.creating"
        :inert="workspaces.creating || workspaces.busy || workspaces.needsRecovery"
        :class="{ compact: width < 940 }"
        @open="open"
        @remove="
          deleting = $event;
          modalError = '';
        "
        @move="askMove"
        @about="about = true"
        @import="importing = true"
        @export="exporting = true"
        @request="creating = $event"
        @folder="creatingFolder = $event"
        @clone="cloning = $event"
        @rename="renaming = $event"
      />
      <WorkspaceManager
        v-if="workspaces.managing"
        :disabled="store.loading || store.pendingOperations > 0 || store.environmentBusy || !!sidebar?.hasPendingInput"
        @open="changeWorkspace"
        @create="workspaces.beginCreate"
        @back="workspaces.managing = false"
      />
      <main v-else class="workspace" aria-label="Workspace" :inert="workspaces.busy || workspaces.needsRecovery" :aria-busy="workspaces.busy">
        <header class="collection-header">
          <AppIcon
            :name="store.active && !workspaces.creating ? 'cube' : 'workspace'"
            :size="20"
          />
          <WorkspaceNameForm v-if="workspaces.creating" @save="changeWorkspace()" @cancel="workspaces.cancelCreate" />
          <strong v-else>{{ collectionName }}</strong>
          <span class="spacer" /><span
            v-if="width < 940"
            class="compact-indicator"
            >Compact layout</span
          >
          <UiMenu
            v-if="!workspaces.creating"
            label="Layout options"
            :items="[
              { id: 'toggle-layout', label: 'Toggle response layout' },
              { id: 'reset-layout', label: 'Reset layout' },
              { id: 'about', label: 'About PostMen' },
            ]"
            align="end"
            icon-only
            @select="action($event as ShellAction)"
            ><AppIcon name="dots"
          /></UiMenu>
          <EnvironmentSelector v-if="!workspaces.creating" :collection-id="store.activeCollectionId" @configure="environmentScope = $event" />
        </header>
        <p v-if="workspaces.creating && workspaces.failure" id="workspace-name-error" class="inline-error workspace-create-error" role="alert">{{ workspaces.failure }}</p>
        <div class="request-tabs-bar">
          <div
            class="request-tabs"
            role="tablist"
            aria-label="Open requests"
            @keydown="tabKey"
          >
            <div v-if="workspaces.creating || !store.activeId" class="request-tab active overview-tab">
              <span><AppIcon name="home" :size="14" />Overview</span>
            </div>
            <div
              v-for="id in workspaces.creating ? [] : store.tabIds"
              :key="id"
              class="request-tab"
              :class="{ active: store.activeId === id, dirty: store.dirty(id) }"
              draggable="true"
              @dragstart="
                draggingTab = id;
                $event.dataTransfer?.setData('text/plain', id);
              "
              @dragover.prevent
              @drop="dropTab($event, id)"
              @dragend="draggingTab = null"
              @contextmenu="tabContextMenu($event, id)"
            >
              <button
                role="tab"
                :data-request-tab="id"
                :aria-selected="store.activeId === id"
                :tabindex="store.activeId === id ? 0 : -1"
                @click="store.activate(id)"
              >
                <span
                  class="method-label"
                  :class="`method-${store.tabs[id]?.draft.method.toLowerCase()}`"
                  >{{ store.tabs[id]?.draft.method }}</span
                ><span class="tab-name">{{ store.tabs[id]?.draft.name }}</span
                ><span
                  v-if="store.dirty(id)"
                  class="dirty-dot"
                  aria-label="Unsaved changes"
                  >●</span
                >
              </button>
              <button
                class="close-tab"
                :aria-label="`Close ${store.tabs[id]?.draft.name}`"
                :disabled="store.tabs[id]?.saving"
                @click="close(id)"
              >
                <AppIcon name="x" :size="12" :stroke="2.5" />
              </button>
            </div>
          </div>
          <IconButton
            label="New request"
            icon="plus"
            :disabled="!store.ready || workspaces.creating"
            @click="createRequest()"
          />
        </div>
        <RequestEditor
          v-if="!workspaces.creating && store.activeId && store.active"
          :id="store.activeId"
          :key="store.activeId"
        />
        <WorkspaceOverview
          v-else
          :creating-workspace="workspaces.creating"
          @create="createCollection"
          @request="createRequest"
          @environments="environmentScope = store.activeCollectionId ? 'collection' : 'global'"
          @about="about = true"
        />
      </main>
    </div>
    <div
      v-if="store.error || store.sessionError || settings.persistenceError"
      class="error-notice"
      role="alert"
    >
      <span>{{
        store.error || store.sessionError || settings.persistenceError
      }}</span
      ><button
        v-if="connection === 'error'"
        :disabled="store.loading"
        @click="connect"
      >
        Retry storage</button
      ><button v-if="store.sessionError" @click="store.persistSession">
        Retry tab persistence</button
      ><button
        v-if="store.error"
        aria-label="Dismiss error"
        @click="store.error = ''"
      >
        Dismiss
      </button>
    </div>
    <StatusBar
      :title="
        development && connection === 'fixture' ? fixtureNotice : undefined
      "
      :version="info?.version ?? '0.2.0'"
      :connection="connectionLabel"
      :fixture="false"
      :dev="false"
      @about="about = true"
    />
    <div class="tab-context-anchor">
      <UiMenu
        ref="tabMenu"
        label="Request tab actions"
        :items="[
          {
            id: 'left',
            label: 'Move tab left',
            disabled: store.tabIds.indexOf(tabContext ?? '') <= 0,
          },
          {
            id: 'right',
            label: 'Move tab right',
            disabled:
              store.tabIds.indexOf(tabContext ?? '') >= store.tabIds.length - 1,
          },
          { id: 'reload', label: 'Reload saved request' },
          { id: 'close', label: 'Close tab' },
        ]"
        @select="tabAction"
      />
    </div>
    <CreateRequestDialog v-if="creating" :parent="creating" @close="creating = null" @created="requestCreated" />
    <UiModal :open="workspaces.needsRecovery" title="Workspace change interrupted" busy @close="() => {}">
      <p>The desktop may have already changed workspaces. Reload the active workspace before editing or saving.</p>
      <p v-if="workspaces.failure" class="inline-error" role="alert">{{ workspaces.failure }}</p>
      <template #footer>
        <UiButton data-autofocus variant="primary" :disabled="workspaces.busy" @click="workspaces.recover">{{ workspaces.busy ? 'Reloading…' : 'Reload active workspace' }}</UiButton>
      </template>
    </UiModal>
    <CreateFolderDialog v-if="creatingFolder" :parent="creatingFolder" @close="creatingFolder = null" @created="creatingFolder = null" />
    <CloneRequestDialog v-if="cloning" :request-id="cloning" :request-name="selectedName({ kind: 'request', id: cloning }) ?? 'Request'" @close="cloning = null" @created="cloning = null; open($event)" />
    <RenameItemDialog v-if="renaming" :item="renaming" :initial-name="selectedName(renaming) ?? ''" @close="renaming = null" @renamed="renaming = null" />
    <UiModal :open="about" title="About PostMen" @close="about = false"
      ><img
        class="about-app-icon"
        src="/titlebar-icon.svg"
        alt="PostMen application icon"
        width="80"
        height="80"
        draggable="false"
      />
      <p><strong>PostMen 0.2.0</strong></p>
      <p>
        Tauri 2 + Vue 3 + TypeScript. Collections, request editing, independent
        drafts and new SQLite storage.
      </p>
      <p class="muted">
        Rust HTTP Send/Cancel, bounded inert response preview, execution
        metadata history, and native unsaved Quit confirmation are available.
        TLS verification is enabled.
      </p>
      <p data-testid="connection-detail">
        {{ connectionLabel }}{{ info ? ` · ${info.platform}` : "" }}
      </p>
      <template #footer
        ><UiButton data-autofocus variant="primary" @click="about = false"
          >Close</UiButton
        ></template
      ></UiModal
    >
    <UiModal
      :open="pendingClose !== null"
      title="Unsaved Changes"
      @close="!busy && (pendingClose = null)"
      ><p>
        Save changes to
        <strong>{{
          pendingClose ? store.tabs[pendingClose]?.draft.name : ""
        }}</strong>
        before closing?
      </p>
      <p v-if="modalError" class="inline-error" role="alert">
        {{ modalError }}
      </p>
      <template #footer
        ><UiButton data-autofocus :disabled="busy" @click="pendingClose = null"
          >Cancel</UiButton
        ><UiButton
          variant="danger"
          :disabled="busy"
          @click="resolveClose(false)"
          >Discard</UiButton
        ><UiButton
          variant="primary"
          :disabled="busy"
          @click="resolveClose(true)"
          >{{ busy ? "Saving…" : "Save" }}</UiButton
        ></template
      ></UiModal
    >
    <UiModal
      :open="deleting !== null"
      :title="`Delete ${deleting?.kind ?? 'item'}`"
      :busy="busy"
      @close="!busy && (deleting = null)"
      ><p>
        Delete <strong>{{ selectedName(deleting) }}</strong
        >{{ deleting?.kind !== "request" ? " and all its contents" : "" }}?
      </p>
      <p
        v-if="
          deleting && store.descendants(deleting).some((id) => store.dirty(id))
        "
        class="inline-error"
      >
        Unsaved drafts in this item will also be discarded.
      </p>
      <p v-if="modalError" class="inline-error" role="alert">
        {{ modalError }}
      </p>
      <template #footer
        ><UiButton data-autofocus :disabled="busy" @click="deleting = null"
          >Cancel</UiButton
        ><UiButton variant="danger" :disabled="busy" @click="deleteItem"
          >Delete</UiButton
        ></template
      ></UiModal
    >
    <UiModal
      :open="moving !== null"
      title="Move to folder"
      @close="!busy && (moving = null)"
      ><p>
        Move <strong>{{ selectedName(moving) }}</strong> within its collection.
      </p>
      <UiSelect
        v-model="destination"
        class="dialog-select"
        label="Destination folder"
        :options="[
          { value: null, label: 'Collection root' },
          ...moveFolders.map((folder) => ({
            value: folder.id,
            label: folder.name,
          })),
        ]"
      />
      <p v-if="modalError" class="inline-error" role="alert">
        {{ modalError }}
      </p>
      <template #footer
        ><UiButton data-autofocus :disabled="busy" @click="moving = null"
          >Cancel</UiButton
        ><UiButton variant="primary" :disabled="busy" @click="moveItem"
          >Move</UiButton
        ></template
      ></UiModal
    >
    <UiModal
      :open="reloading !== null"
      title="Reload saved request"
      @close="!busy && (reloading = null)"
      ><p>
        This replaces the open draft with the saved version and clears its undo
        history. Unsaved changes will be discarded.
      </p>
      <p v-if="modalError" class="inline-error" role="alert">
        {{ modalError }}
      </p>
      <template #footer
        ><UiButton data-autofocus :disabled="busy" @click="reloading = null"
          >Cancel</UiButton
        ><UiButton variant="danger" :disabled="busy" @click="reloadRequest"
          >Reload saved</UiButton
        ></template
      ></UiModal
    >
    <ToastHost />
    <ImportCollectionDialog v-if="importing" @close="importing = false" @imported="id => { importing = false; sidebar?.revealCollection(id); }" />
    <ExportCollectionDialog v-if="exporting" @close="exporting = false" />
    <EnvironmentManager v-if="environmentScope" :collection-id="store.activeCollectionId" :initial-scope="environmentScope" @close="environmentScope = null" />
    <QuitDialog
      :open="quitOpen"
      @close="quitOpen = false"
      @finished="
        fixtureClosed = true;
        quitOpen = false;
      "
    />
  </div>
</template>
