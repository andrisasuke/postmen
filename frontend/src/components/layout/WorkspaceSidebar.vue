<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useWorkspaceStore } from "../../stores/workspace";
import { useSettingsStore, clamp } from "../../stores/settings";
import { errorMessage } from "../../services/data";
import type { Parent, TreeRef, TreeKind } from "../../types/data";
import type { MenuItem } from "../../types/shell";
import AppIcon from "../ui/AppIcon.vue";
import IconButton from "../ui/IconButton.vue";
import UiInput from "../ui/UiInput.vue";
import UiMenu from "../ui/UiMenu.vue";
defineProps<{ creatingWorkspace?: boolean }>();
const emit = defineEmits<{
  open: [id: string];
  remove: [item: TreeRef];
  move: [item: TreeRef];
  about: [];
  import: [];
  export: [];
  request: [parent: Parent];
  folder: [parent: Parent];
  clone: [id: string];
  rename: [item: TreeRef];
}>();
const store = useWorkspaceStore();
const settings = useSettingsStore();
const search = ref("");
const showSearch = ref(false);
const expanded = computed(() => settings.preferences.treeExpanded);
const searchExpanded = ref<Record<string, boolean>>({});
const searchQuery = computed(() => search.value.trim().toLowerCase());
watch(searchQuery, () => { searchExpanded.value = {}; });
function isExpanded(id: string) {
  return (searchQuery.value ? searchExpanded.value[id] : expanded.value[id]) !== false;
}
function setExpanded(id: string, value: boolean) {
  (searchQuery.value ? searchExpanded.value : expanded.value)[id] = value;
}
const form = ref<{
  kind: TreeKind;
  parent: Parent | null;
  rename: TreeRef | null;
} | null>(null);
const name = ref("");
const busy = ref(false);
const failure = ref("");
const field = ref<HTMLInputElement>();
const menu = ref<InstanceType<typeof UiMenu>>();
const contextItem = ref<TreeRef | null>(null);
const dragging = ref<TreeRef | null>(null);
interface TreeRow extends TreeRef {
  name: string;
  method?: string;
  depth: number;
  collectionId: string;
  parentId: string | null;
}
const all = computed<TreeRow[]>(() => [
  ...store.data.collections.map((c) => ({
    kind: "collection" as const,
    id: c.id,
    name: c.name,
    depth: 0,
    collectionId: c.id,
    parentId: null,
  })),
  ...store.data.folders.map((f) => ({
    kind: "folder" as const,
    id: f.id,
    name: f.name,
    depth: 0,
    collectionId: f.collectionId,
    parentId: f.parentId,
  })),
  ...store.data.requests.map((r) => ({
    kind: "request" as const,
    id: r.id,
    name: store.tabs[r.id]?.draft.name ?? r.name,
    method: store.tabs[r.id]?.draft.method ?? r.method,
    depth: 0,
    collectionId: r.collectionId,
    parentId: r.folderId,
  })),
]);
const treeRows = computed(() => {
  const result: TreeRow[] = [];
  const query = searchQuery.value;
  const visited = new Set<string>();
  function children(collectionId: string, parentId: string | null) {
    return all.value
      .filter(
        (x) =>
          x.kind !== "collection" &&
          x.collectionId === collectionId &&
          x.parentId === parentId,
      )
      .sort((a, b) => {
        const position = (x: TreeRow) =>
          x.kind === "folder"
            ? (store.data.folders.find((f) => f.id === x.id)?.position ?? 0)
            : (store.data.requests.find((r) => r.id === x.id)?.position ?? 0);
        return position(a) - position(b) || a.id.localeCompare(b.id);
      });
  }
  function match(row: TreeRow, seen = new Set<string>()): boolean {
    if (row.name.toLowerCase().includes(query)) return true;
    if (row.kind === "request" || seen.has(row.id)) return false;
    seen.add(row.id);
    return children(
      row.collectionId,
      row.kind === "collection" ? null : row.id,
    ).some((child) => match(child, seen));
  }
  function walk(row: TreeRow, depth: number, parentMatches: boolean) {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    const matches = parentMatches || row.name.toLowerCase().includes(query);
    if (query && !matches && !match(row)) return;
    result.push({ ...row, depth });
    if (row.kind !== "request" && isExpanded(row.id))
      for (const child of children(
        row.collectionId,
        row.kind === "collection" ? null : row.id,
      ))
        walk(child, depth + 1, matches);
  }
  for (const collection of [...store.data.collections].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  )) {
    const row = all.value.find((r) => r.id === collection.id);
    if (row) walk(row, 0, false);
  }
  return result;
});
const contextRow = computed(() =>
  all.value.find((r) => r.id === contextItem.value?.id),
);
const contextItems = computed<MenuItem[]>(() => {
  const row = contextRow.value;
  if (!row) return [];
  const siblings = store.siblings(row);
  const index = siblings.findIndex((s) => s.id === row.id);
  return [
    ...(row.kind === "request"
      ? [{ id: "open", label: "Open request" }, { id: "clone", label: "Clone" }]
      : [
          { id: "new-request", label: "New request" },
          { id: "new-folder", label: "New folder" },
          { id: "toggle-expanded", label: isExpanded(row.id) ? "Collapse" : "Expand" },
        ]),
    { id: "rename", label: "Rename" },
    ...(row.kind !== "collection"
      ? [{ id: "move", label: "Move to folder" }]
      : []),
    { id: "up", label: "Move up", disabled: index <= 0 },
    { id: "down", label: "Move down", disabled: index >= siblings.length - 1 },
    { id: "delete", label: `Delete ${row.kind}`, danger: true },
  ];
});
async function begin(
  kind: TreeKind,
  parent: Parent | null = null,
  rename: TreeRef | null = null,
) {
  if (rename && kind !== "collection") {
    form.value = null;
    emit("rename", rename);
    return;
  }
  if ((kind === "request" || kind === "folder") && !rename && parent) {
    form.value = null;
    setExpanded(parent.parentId ?? parent.collectionId, true);
    if (kind === "request") emit("request", parent);
    else emit("folder", parent);
    return;
  }
  form.value = { kind, parent, rename };
  name.value = rename
    ? (all.value.find((r) => r.id === rename.id)?.name ?? "")
    : "";
  failure.value = "";
  await nextTick();
  field.value?.focus();
  field.value?.select();
}
defineExpose({
  hasPendingInput: computed(() => form.value !== null || busy.value),
  revealCollection: (id: string) => { search.value = ""; expanded.value[id] = true; },
  createCollection: () => begin("collection"),
  createRequest: (parent: Parent) => begin("request", parent),
});
async function submit() {
  if (!form.value || busy.value) return;
  busy.value = true;
  failure.value = "";
  const current = form.value;
  try {
    if (current.rename) await store.rename(current.rename, name.value);
    else if (current.kind === "collection") {
      const created = await store.createCollection(name.value);
      expanded.value[created.id] = true;
    }
    form.value = null;
  } catch (e) {
    failure.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
function click(row: TreeRow) {
  if (row.kind === "request") emit("open", row.id);
  else {
    setExpanded(row.id, !isExpanded(row.id));
    store.selectedCollectionId = row.collectionId;
  }
}
function context(
  event: MouseEvent | KeyboardEvent,
  item: TreeRef,
  anchorToTrigger = false,
) {
  event.preventDefault();
  contextItem.value = { kind: item.kind, id: item.id };
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const atPointer = event instanceof MouseEvent && !anchorToTrigger;
  const keyboard = event instanceof KeyboardEvent ||
    (event.type === "click" && event.detail === 0);
  void menu.value?.openAt(
    atPointer ? event.clientX : rect.left,
    atPointer ? event.clientY : rect.bottom,
    target,
    keyboard,
  );
}
async function contextAction(action: string) {
  const row = contextRow.value;
  if (!row) return;
  const item = { id: row.id, kind: row.kind };
  try {
    if (action === "open") emit("open", row.id);
    if (action === "clone" && row.kind === "request") emit("clone", row.id);
    if (action === "toggle-expanded" && row.kind !== "request") setExpanded(row.id, !isExpanded(row.id));
    if (action === "new-request" || action === "new-folder")
      await begin(action === "new-request" ? "request" : "folder", {
        collectionId: row.collectionId,
        parentId: row.kind === "folder" ? row.id : null,
      });
    if (action === "rename") await begin(row.kind, null, item);
    if (action === "delete") emit("remove", item);
    if (action === "move") emit("move", item);
    if (action === "up" || action === "down")
      await store.moveSibling(item, action === "up" ? -1 : 1);
  } catch (e) {
    store.error = errorMessage(e);
  }
}
function startDrag(event: DragEvent, row: TreeRow) {
  dragging.value = { kind: row.kind, id: row.id };
  event.dataTransfer?.setData("text/plain", row.id);
}
async function drop(event: DragEvent, target: TreeRow) {
  event.preventDefault();
  const source = dragging.value;
  dragging.value = null;
  if (!source || source.id === target.id) return;
  const items = store.siblings(target);
  if (!items.some((i) => i.id === source.id)) {
    store.error = "Use Move to folder to move between parents or collections.";
    return;
  }
  const ordered = items.filter((i) => i.id !== source.id);
  ordered.splice(
    ordered.findIndex((i) => i.id === target.id),
    0,
    source,
  );
  try {
    await store.reorderSiblings(target, ordered);
  } catch (e) {
    store.error = errorMessage(e);
  }
}
function resize(event: PointerEvent) {
  settings.preferences.sidebarWidth = clamp(event.clientX, 220, 600);
}
function stop() {
  document.documentElement.classList.remove("resizing");
  window.removeEventListener("pointermove", resize);
  window.removeEventListener("pointerup", stop);
  window.removeEventListener("pointercancel", stop);
  window.removeEventListener("blur", stop);
}
function start(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  document.documentElement.classList.add("resizing");
  window.addEventListener("pointermove", resize);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("blur", stop);
}
function resizeKey(event: KeyboardEvent) {
  if (["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) {
    event.preventDefault();
    settings.preferences.sidebarWidth =
      event.key === "Home"
        ? 250
        : clamp(
            settings.preferences.sidebarWidth +
              (event.key === "ArrowLeft" ? -10 : 10),
            220,
            600,
          );
  }
}
onBeforeUnmount(stop);
</script>
<template>
  <aside
    class="collection-sidebar"
    :style="{ width: `${settings.preferences.sidebarWidth}px` }"
    data-testid="sidebar"
    aria-label="Collections"
  >
    <div class="sidebar-heading">
      <AppIcon name="cube" /><strong>Collections</strong
      ><span class="spacer" /><IconButton
        label="Search collections"
        icon="search"
        :active="showSearch"
        @click="showSearch = !showSearch"
      /><IconButton
        label="Create collection"
        icon="plus"
        :disabled="!store.ready"
        @click="begin('collection')"
      /><IconButton
        label="Import Postman collection"
        icon="download"
        :disabled="!store.ready || busy"
        @click="emit('import')"
      />
      <IconButton
        label="Export collections"
        icon="upload"
        :disabled="!store.ready || busy || !store.data.collections.length"
        @click="emit('export')"
      />
    </div>
    <div v-if="showSearch" class="sidebar-search">
      <UiInput
        v-model="search"
        label="Search collections"
        placeholder="Search collections and requests…"
      />
    </div>
    <form
      v-if="form && !creatingWorkspace"
      class="tree-create-form"
      :aria-busy="busy"
      @submit.prevent="submit"
    >
      <label for="tree-item-name" class="sr-only">{{
        form.rename ? "Rename" : `New ${form.kind}`
      }}</label>
      <div class="tree-create-controls">
        <input
          id="tree-item-name"
          ref="field"
          v-model="name"
          class="ui-input"
          aria-label="Item name"
          maxlength="200"
          :disabled="busy"
          autocomplete="off"
          @keydown.esc.prevent="!busy && (form = null)"
        />
        <button
          type="submit"
          class="tree-form-action tree-form-confirm"
          :aria-label="`Confirm ${form.rename ? 'rename' : 'create'} ${form.kind}`"
          :title="busy ? 'Saving…' : `Confirm ${form.rename ? 'rename' : 'create'} ${form.kind}`"
          :disabled="busy"
        >
          <AppIcon name="check" :size="25" :stroke="2" />
        </button>
        <button
          type="button"
          class="tree-form-action tree-form-cancel"
          :aria-label="`Cancel ${form.rename ? 'rename' : 'create'} ${form.kind}`"
          :title="`Cancel ${form.rename ? 'rename' : 'create'} ${form.kind}`"
          :disabled="busy"
          @click="form = null"
        >
          <AppIcon name="x" :size="25" :stroke="1.75" />
        </button>
      </div>
      <p v-if="failure" role="alert" class="inline-error">{{ failure }}</p>
    </form>
    <div v-if="creatingWorkspace || !store.data.collections.length" class="sidebar-empty">
      <p>No collections found.</p>
      <p v-if="store.ready" class="sidebar-empty-actions">
        <button type="button" :disabled="busy" @click="begin('collection')">Create</button>
        or
        <button type="button" :disabled="busy" @click="emit('import')">Import</button>
        Collection.
      </p>
      <span v-else>Open the desktop app to store requests.</span>
    </div>
    <div v-else class="data-tree" aria-label="Collection tree">
      <div
        v-for="row in treeRows"
        :key="row.id"
        class="data-tree-entry"
      >
        <button
          type="button"
          class="data-tree-row has-actions"
          :class="{
            selected: row.kind === 'request' && store.activeId === row.id,
            'collection-row': row.kind === 'collection',
          }"
          :style="{ paddingLeft: `${12 + row.depth * 16}px` }"
          :aria-expanded="
            row.kind === 'request'
              ? undefined
              : isExpanded(row.id)
          "
          :aria-current="
            row.kind === 'request' && store.activeId === row.id
              ? 'page'
              : undefined
          "
          draggable="true"
          @click="click(row)"
          @contextmenu="context($event, row)"
          @keydown.shift.f10="context($event, row)"
          @dragstart="startDrag($event, row)"
          @dragover.prevent
          @drop="drop($event, row)"
          @dragend="dragging = null"
        >
          <span
            v-for="level in row.depth"
            :key="level"
            class="tree-guide"
            aria-hidden="true"
            :style="{ left: `${19 + (level - 1) * 16}px` }"
          />
          <span
            v-if="row.kind === 'request'"
            class="method-label"
            :class="`method-${row.method?.toLowerCase()}`"
            >{{ row.method }}</span
          ><AppIcon
            v-else
            :name="isExpanded(row.id) ? 'down' : 'right'"
          />
          <span class="tree-name">{{ row.name }}</span
          ><span
            v-if="row.kind === 'request' && store.dirty(row.id)"
            class="dirty-dot"
            aria-label="Unsaved changes"
            >●</span
          >
        </button>
        <IconButton
          class="tree-row-actions"
          :label="`Actions for ${row.name}`"
          icon="dots"
          aria-haspopup="menu"
          :aria-expanded="!!menu?.isOpen && contextItem?.id === row.id"
          :aria-controls="menu?.isOpen && contextItem?.id === row.id ? menu.id : undefined"
          @click.stop="context($event, row, true)"
          @contextmenu.stop="context($event, row)"
          @keydown.down.stop.prevent="context($event, row)"
          @keydown.up.stop.prevent="context($event, row)"
          @keydown.shift.f10.stop="context($event, row)"
        />
      </div>
      <p v-if="!treeRows.length" class="sidebar-empty">No matching items.</p>
    </div>
    <div class="context-menu-anchor">
      <UiMenu
        ref="menu"
        label="Collection actions"
        :items="contextItems"
        :restore-pointer-focus="false"
        @select="contextAction"
        ><AppIcon name="dots"
      /></UiMenu>
    </div>
    <div
      class="sidebar-resizer"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      :aria-valuenow="settings.preferences.sidebarWidth"
      :aria-valuemin="220"
      :aria-valuemax="600"
      tabindex="0"
      @pointerdown="start"
      @keydown="resizeKey"
    />
  </aside>
</template>
