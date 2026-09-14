import { computed, markRaw, onScopeDispose, reactive, ref, watch } from "vue";
import { defineStore } from "pinia";
import type { EditorState } from "@codemirror/state";
import type {
  Attachment,
  DataApi,
  EnvironmentInput,
  NewRequestContent,
  Parent,
  RequestDoc,
  RequestSummary,
  RequestView,
  Session,
  TreeRef,
} from "../types/data";
import { clone, editable, emptyWorkspace, newView } from "../types/data";
import { DataError, errorMessage } from "../services/data";
import { useSettingsStore } from "./settings";
import { useNotificationsStore } from "./notifications";
import { environmentContent, environmentVariables } from "../services/variables";
import type { ImportedCollection } from "../services/collection-import";

export interface DraftTab {
  saved: RequestDoc;
  draft: RequestDoc;
  view: RequestView;
  saving: boolean;
  editorState: EditorState | null;
}
const summary = (doc: RequestDoc): RequestSummary => ({
  id: doc.id,
  collectionId: doc.collectionId,
  folderId: doc.folderId,
  name: doc.name,
  method: doc.method,
  position: doc.position,
  revision: doc.revision,
});

function sessionContent(value: Session): string {
  // Native JSON maps may return keys in a different order; array order is meaningful.
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item);
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const data = ref(emptyWorkspace());
  const tabs = reactive<Record<string, DraftTab>>({});
  const tabIds = ref<string[]>([]);
  const activeId = ref<string | null>(null);
  const selectedCollectionId = ref<string | null>(null);
  const ready = ref(false);
  const loading = ref(false);
  const error = ref("");
  const sessionError = ref("");
  const environmentBusy = ref(false);
  const transitioning = ref(false);
  const pendingOperations = ref(0);
  const attachments = reactive<Record<string, Attachment>>({});
  const settings = useSettingsStore();
  const notifications = useNotificationsStore();
  // Wrap public mutations only. Nested calls (for example clone -> create) stay silent.
  function notifyMutation<Args extends unknown[], Result>(
    action: (...args: Args) => Promise<Result>,
    messages: (...args: Args) => { success: string | null; error: string },
  ) {
    return async (...args: Args): Promise<Result> => {
      const message = messages(...args);
      try {
        const result = await action(...args);
        if (message.success) notifications.success(message.success);
        return result;
      } catch (error) {
        notifications.error(message.error);
        throw error;
      }
    };
  }
  let api: DataApi | null = null;
  let applying = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sessionQueue = Promise.resolve();
  let sessionSuspended = false;
  const persistedSessions = new WeakMap<DataApi, string>();
  const opening = new Map<string, Promise<void>>();
  const active = computed(() =>
    activeId.value ? tabs[activeId.value] : undefined,
  );
  const activeCollectionId = computed(
    () => active.value?.draft.collectionId ?? selectedCollectionId.value,
  );
  const dirty = (id: string) => {
    const tab = tabs[id];
    return !!tab && editable(tab.saved) !== editable(tab.draft);
  };
  const dirtyIds = computed(() => tabIds.value.filter(dirty));
  const hasDirty = computed(() => dirtyIds.value.length > 0);
  function backend(): DataApi {
    if (transitioning.value) throw new DataError("BUSY", "Wait for the workspace change to finish.");
    if (!api)
      throw new DataError(
        "DESKTOP_REQUIRED",
        "Open the Tauri desktop app to use persistent collections.",
      );
    return new Proxy(api, {
      get(target, property) {
        const method: unknown = Reflect.get(target, property);
        if (typeof method !== "function") return method;
        return async (...args: unknown[]) => {
          pendingOperations.value++;
          try { return await Reflect.apply(method, target, args); }
          finally { pendingOperations.value--; }
        };
      },
    });
  }
  async function beginWorkspaceTransition() {
    if (transitioning.value || loading.value || pendingOperations.value || opening.size
      || environmentBusy.value || Object.values(tabs).some(tab => tab.saving)) {
      throw new DataError("BUSY", "Wait for current operations to finish before changing workspaces.");
    }
    if (hasDirty.value) throw new DataError("UNSAVED_CHANGES", "Save or discard request changes before changing workspaces.");
    transitioning.value = true;
    try {
      capturePane();
      if (!(await persistSession())) throw new DataError("SESSION_ERROR", "Tab state could not be saved. Retry before changing workspaces.");
      if (hasDirty.value) throw new DataError("UNSAVED_CHANGES", "A request changed while saving tab state. Save or discard it before changing workspaces.");
      sessionSuspended = true;
    } catch (error) { transitioning.value = false; throw error; }
  }
  function applyWorkspace(incoming: ReturnType<typeof emptyWorkspace>, documents: RequestDoc[]) {
    if (timer) clearTimeout(timer);
    ready.value = false;
    activeId.value = null;
    for (const id of Object.keys(tabs)) delete tabs[id];
    for (const id of Object.keys(attachments)) delete attachments[id];
    tabIds.value = [];
    data.value = incoming;
    for (const item of incoming.attachments) attachments[item.id] = item;
    selectedCollectionId.value = incoming.collections[0]?.id ?? null;
    for (const id of incoming.session.tabIds) {
      const doc = documents.find(doc => doc.id === id);
      if (doc) addTab(doc, incoming.session.views[id]);
    }
    if (api) persistedSessions.set(api, sessionContent(incoming.session));
    activate(incoming.session.activeId);
    error.value = incoming.warnings.join(" ");
    sessionError.value = "";
    ready.value = true;
  }
  function endWorkspaceTransition() { sessionSuspended = false; transitioning.value = false; }
  function session(): Session {
    const valid = tabIds.value.filter(
      (id) => tabs[id] && data.value.requests.some((r) => r.id === id),
    );
    return clone({
      tabIds: valid,
      activeId:
        activeId.value && valid.includes(activeId.value)
          ? activeId.value
          : null,
      views: Object.fromEntries(
        valid.flatMap((id) => (tabs[id] ? [[id, tabs[id]!.view]] : [])),
      ),
    });
  }
  async function persistSession(): Promise<boolean> {
    if (timer) clearTimeout(timer);
    if (sessionSuspended) return false;
    if (!ready.value || !api) return true;
    const payload = session();
    const serialized = sessionContent(payload);
    const service = api;
    const next = sessionQueue
      .then(async () => {
        // Check inside the queue so identical in-flight writes also coalesce.
        if (persistedSessions.get(service) === serialized) return;
        const saved = await service.saveSession(payload);
        persistedSessions.set(service, sessionContent(saved));
      })
      .then(() => {
        sessionError.value = "";
      });
    sessionQueue = next.catch((e) => {
      persistedSessions.delete(service);
      sessionError.value = errorMessage(e);
    });
    try { await next; return true; } catch { return false; }
  }
  function scheduleSession() {
    if (timer) clearTimeout(timer);
    if (ready.value && !transitioning.value)
      timer = setTimeout(() => {
        void persistSession();
      }, 250);
  }
  onScopeDispose(() => {
    if (timer) clearTimeout(timer);
  });
  function capturePane() {
    if (active.value)
      active.value.view.pane = clone({
        orientation: settings.preferences.orientation,
        requestWidth: settings.preferences.requestWidth,
        requestHeight: settings.preferences.requestHeight,
        requestCollapsed: settings.preferences.requestCollapsed,
        responseCollapsed: settings.preferences.responseCollapsed,
      });
  }
  function activate(id: string | null) {
    if (id !== null && !tabs[id]) return;
    capturePane();
    applying = true;
    activeId.value = id;
    if (active.value) {
      selectedCollectionId.value = active.value.draft.collectionId;
      Object.assign(settings.preferences, clone(active.value.view.pane));
    }
    applying = false;
    scheduleSession();
  }
  watch(
    () => ({
      orientation: settings.preferences.orientation,
      requestWidth: settings.preferences.requestWidth,
      requestHeight: settings.preferences.requestHeight,
      requestCollapsed: settings.preferences.requestCollapsed,
      responseCollapsed: settings.preferences.responseCollapsed,
    }),
    () => {
      if (!applying) {
        capturePane();
        scheduleSession();
      }
    },
    { flush: "sync" },
  );
  function updateView(id: string, change: Partial<RequestView>) {
    const tab = tabs[id];
    if (tab) {
      Object.assign(tab.view, change);
      scheduleSession();
    }
  }
  function cacheEditor(id: string, state: EditorState) {
    if (tabs[id]) tabs[id].editorState = markRaw(state);
  }
  function addTab(doc: RequestDoc, view?: RequestView) {
    tabs[doc.id] = {
      saved: clone(doc),
      draft: clone(doc),
      view: clone(view ?? newView(doc)),
      saving: false,
      editorState: null,
    };
    if (!tabIds.value.includes(doc.id)) tabIds.value.push(doc.id);
  }
  async function initialize(service: DataApi): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    error.value = "";
    api = service;
    try {
      const incoming = await service.loadWorkspace();
      persistedSessions.set(service, sessionContent(incoming.session));
      data.value = incoming;
      for (const item of incoming.attachments) attachments[item.id] = item;
      selectedCollectionId.value = incoming.collections[0]?.id ?? null;
      for (const id of incoming.session.tabIds) {
        if (tabs[id]) continue;
        try {
          const doc = await service.getRequest(id);
          addTab(doc, incoming.session.views[id]);
        } catch (e) {
          error.value = `Some tabs could not be restored. ${errorMessage(e)}`;
        }
      }
      ready.value = true;
      activate(
        incoming.session.activeId && tabs[incoming.session.activeId]
          ? incoming.session.activeId
          : null,
      );
      if (incoming.warnings.length) error.value = incoming.warnings.join(" ");
    } finally {
      loading.value = false;
    }
  }
  async function open(id: string): Promise<void> {
    if (tabs[id]) {
      activate(id);
      return;
    }
    if (opening.has(id)) {
      await opening.get(id);
      activate(id);
      return;
    }
    if (tabIds.value.length + opening.size >= 100)
      throw new DataError(
        "LIMIT_EXCEEDED",
        "Close a tab before opening more than 100 requests.",
      );
    const operation = (async () => {
      const doc = await backend().getRequest(id);
      if (!data.value.requests.some((request) => request.id === id))
        throw new DataError(
          "NOT_FOUND",
          "This request was deleted while opening.",
        );
      if (!tabs[id]) addTab(doc);
    })();
    opening.set(id, operation);
    try {
      await operation;
      activate(id);
    } finally {
      opening.delete(id);
    }
  }
  function updateSummary(doc: RequestDoc) {
    const index = data.value.requests.findIndex((r) => r.id === doc.id);
    if (index < 0) data.value.requests.push(summary(doc));
    else data.value.requests[index] = summary(doc);
  }
  async function save(id: string): Promise<boolean> {
    const tab = tabs[id];
    if (!tab) return false;
    if (tab.saving) return false;
    if (!dirty(id)) return true;
    tab.saving = true;
    error.value = "";
    const submitted = clone(tab.draft);
    try {
      const saved = await backend().saveRequest(submitted);
      tab.saved = clone(saved);
      if (editable(tab.draft) === editable(submitted)) tab.draft = clone(saved);
      else {
        tab.draft.revision = saved.revision;
        tab.draft.updatedAt = saved.updatedAt;
        tab.draft.position = saved.position;
      }
      updateSummary(saved);
      scheduleSession();
      notifications.success(dirty(id)
        ? "Request saved. Newer edits are still unsaved."
        : "Request saved successfully");
      return !dirty(id);
    } catch (e) {
      error.value = errorMessage(e);
      notifications.error("Failed to save request");
      throw e;
    } finally {
      tab.saving = false;
    }
  }
  function closeClean(id: string) {
    if (!tabs[id] || dirty(id) || tabs[id].saving) return false;
    const index = tabIds.value.indexOf(id);
    const next = tabIds.value.filter((x) => x !== id);
    if (activeId.value === id)
      activate(next[Math.min(index, next.length - 1)] ?? null);
    delete tabs[id];
    tabIds.value = next;
    scheduleSession();
    return true;
  }
  function discard(id: string) {
    const tab = tabs[id];
    if (tab && !tab.saving) {
      tab.draft = clone(tab.saved);
      tab.editorState = null;
      return true;
    }
    return false;
  }
  async function reloadSaved(id: string) {
    const tab = tabs[id];
    if (!tab || tab.saving) return;
    tab.saving = true;
    const before = editable(tab.draft);
    try {
      const doc = await backend().getRequest(id);
      if (editable(tab.draft) !== before)
        throw new DataError(
          "UNSAVED_CHANGES",
          "The draft changed while reloading. Your latest edits were kept; reload again to discard them.",
        );
      tab.saved = clone(doc);
      tab.draft = clone(doc);
      tab.editorState = null;
      updateSummary(doc);
    } finally {
      tab.saving = false;
    }
  }
  function reorderTabs(ids: string[]) {
    if (
      ids.length !== tabIds.value.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !tabIds.value.includes(id))
    )
      return;
    tabIds.value = [...ids];
    scheduleSession();
  }
  function nextTab(delta: number) {
    if (!tabIds.value.length) return;
    const index = activeId.value ? tabIds.value.indexOf(activeId.value) : -1;
    activate(
      tabIds.value[
        (index + delta + tabIds.value.length) % tabIds.value.length
      ] ?? null,
    );
  }
  function applyImportedCollection(result: ImportedCollection) {
    const { workspace, collectionId, replacedId } = result;
    if (replacedId) {
      for (const id of descendants({ kind: "collection", id: replacedId })) closeClean(id);
    }
    // Merge just the imported scope. Unrelated drafts, tabs and in-flight updates survive.
    data.value.collections = data.value.collections.filter(c => c.id !== collectionId)
      .concat(workspace.collections.filter(c => c.id === collectionId))
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    data.value.folders = data.value.folders.filter(f => f.collectionId !== collectionId)
      .concat(workspace.folders.filter(f => f.collectionId === collectionId));
    data.value.requests = data.value.requests.filter(r => r.collectionId !== collectionId)
      .concat(workspace.requests.filter(r => r.collectionId === collectionId));
    data.value.environments = data.value.environments.filter(e => e.collectionId !== collectionId)
      .concat(workspace.environments.filter(e => e.collectionId === collectionId));
    data.value.environmentSelections = data.value.environmentSelections.filter(s => s.collectionId !== collectionId)
      .concat(workspace.environmentSelections.filter(s => s.collectionId === collectionId));
    selectedCollectionId.value = collectionId;
    activate(null);
    scheduleSession();
  }
  async function createCollection(name: string) {
    const result = await backend().createCollection(name);
    data.value.collections.push(result);
    selectedCollectionId.value = result.id;
    activate(null);
    return result;
  }
  async function createFolder(parent: Parent, name: string) {
    const result = await backend().createFolder({ ...parent, name });
    data.value.folders.push(result);
    return result;
  }
  async function createRequest(parent: Parent, name: string, content?: NewRequestContent) {
    if (tabIds.value.length >= 100)
      throw new DataError(
        "LIMIT_EXCEEDED",
        "Close a tab before creating another request.",
      );
    const doc = await backend().createRequest({
      collectionId: parent.collectionId,
      folderId: parent.parentId,
      name,
      ...(content ? { content } : {}),
    });
    updateSummary(doc);
    addTab(doc);
    activate(doc.id);
    return doc;
  }
  async function cloneRequest(id: string, name: string) {
    if (tabs[id]?.saving)
      throw new DataError("BUSY", "Wait for this request to finish saving before cloning.");
    // Clone the visible draft when open, otherwise load the saved request.
    // New row IDs keep edits independent; attachment IDs still reference the same files.
    const source = clone(tabs[id]?.draft ?? await backend().getRequest(id));
    const copy = await createRequest(
      { collectionId: source.collectionId, parentId: source.folderId },
      name,
      {
        method: source.method,
        url: source.url,
        bodyKind: source.bodyKind,
        body: source.body,
        params: source.params.map(row => ({ ...row, id: crypto.randomUUID() })),
        headers: source.headers.map(row => ({ ...row, id: crypto.randomUUID() })),
        formData: source.formData.map(row => ({ ...row, id: crypto.randomUUID() })),
      },
    );
    return copy;
  }
  function unchangedName(item: TreeRef, name: string) {
    const list = item.kind === "collection" ? data.value.collections
      : item.kind === "folder" ? data.value.folders : data.value.requests;
    return list.find(node => node.id === item.id)?.name === name;
  }
  async function rename(item: TreeRef, name: string) {
    if (unchangedName(item, name)) return;
    if (item.kind === "collection") {
      const result = await backend().renameCollection(item.id, name);
      data.value.collections = data.value.collections.map((c) =>
        c.id === item.id ? result : c,
      );
    } else if (item.kind === "folder") {
      const folder = data.value.folders.find((f) => f.id === item.id);
      if (!folder) throw new DataError("NOT_FOUND", "This folder no longer exists.");
      const result = await backend().updateFolder({
        id: item.id,
        parentId: folder.parentId,
        name,
      });
      data.value.folders = data.value.folders.map((f) =>
        f.id === item.id ? result : f,
      );
    } else {
      await changeMetadata(item.id, { name });
    }
  }
  async function changeMetadata(
    id: string,
    change: { name?: string; folderId?: string | null },
  ) {
    const tab = tabs[id];
    if (tab?.saving)
      throw new DataError("BUSY", "Wait for this request's save to finish.");
    if (dirty(id))
      throw new DataError(
        "UNSAVED_CHANGES",
        "Save or discard this draft before renaming or moving it.",
      );
    if (tab) tab.saving = true;
    try {
      const original = tab ? clone(tab.saved) : await backend().getRequest(id);
      const submitted = { ...original, ...change };
      const saved = await backend().saveRequest(submitted);
      updateSummary(saved);
      const current = tabs[id];
      if (current) {
        current.saved = clone(saved);
        if (editable(current.draft) === editable(original))
          current.draft = clone(saved);
        else {
          // Only merge the requested metadata, never replace edits made while
          // the native save was running.
          if (change.name !== undefined && current.draft.name === original.name)
            current.draft.name = saved.name;
          if (
            change.folderId !== undefined &&
            current.draft.folderId === original.folderId
          )
            current.draft.folderId = saved.folderId;
          current.draft.revision = saved.revision;
          current.draft.updatedAt = saved.updatedAt;
          current.draft.position = saved.position;
        }
      }
    } finally {
      if (tab) tab.saving = false;
    }
  }
  function descendants(item: TreeRef): string[] {
    if (item.kind === "request") return [item.id];
    if (item.kind === "collection")
      return data.value.requests
        .filter((r) => r.collectionId === item.id)
        .map((r) => r.id);
    const folders = new Set([item.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of data.value.folders) {
        if (
          folder.parentId &&
          folders.has(folder.parentId) &&
          !folders.has(folder.id)
        ) {
          folders.add(folder.id);
          changed = true;
        }
      }
    }
    return data.value.requests
      .filter((r) => r.folderId && folders.has(r.folderId))
      .map((r) => r.id);
  }
  async function remove(item: TreeRef) {
    const affected = descendants(item);
    if (affected.some((id) => tabs[id]?.saving))
      throw new DataError(
        "BUSY",
        "Wait for request saves to finish before deleting.",
      );
    const locked = affected.flatMap((id) => (tabs[id] ? [tabs[id]!] : []));
    for (const tab of locked) tab.saving = true;
    try {
      if (item.kind === "collection") await backend().deleteCollection(item.id);
      else if (item.kind === "folder") await backend().deleteFolder(item.id);
      else await backend().deleteRequest(item.id);
    } finally {
      for (const tab of locked) tab.saving = false;
    }
    for (const id of affected) {
      if (tabs[id]) {
        tabs[id].draft = clone(tabs[id].saved);
        closeClean(id);
      }
    }
    data.value.requests = data.value.requests.filter(
      (r) => !affected.includes(r.id),
    );
    if (item.kind === "collection") {
      data.value.collections = data.value.collections.filter(
        (c) => c.id !== item.id,
      );
      data.value.folders = data.value.folders.filter(
        (f) => f.collectionId !== item.id,
      );
      data.value.environments = data.value.environments.filter(e => e.collectionId !== item.id);
      data.value.environmentSelections = data.value.environmentSelections.filter(s => s.collectionId !== item.id);
      if (selectedCollectionId.value === item.id)
        selectedCollectionId.value = data.value.collections[0]?.id ?? null;
    }
    if (item.kind === "folder") {
      const removed = new Set([item.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const f of data.value.folders)
          if (f.parentId && removed.has(f.parentId) && !removed.has(f.id)) {
            removed.add(f.id);
            changed = true;
          }
      }
      data.value.folders = data.value.folders.filter((f) => !removed.has(f.id));
    }
    await persistSession();
  }
  function siblings(item: TreeRef): TreeRef[] {
    if (item.kind === "collection")
      return [...data.value.collections]
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .map((c) => ({ kind: "collection", id: c.id }));
    const node =
      item.kind === "folder"
        ? data.value.folders.find((x) => x.id === item.id)
        : data.value.requests.find((x) => x.id === item.id);
    if (!node) return [];
    const parent = "parentId" in node ? node.parentId : node.folderId;
    return [
      ...data.value.folders
        .filter(
          (f) => f.collectionId === node.collectionId && f.parentId === parent,
        )
        .map((f) => ({ ...f, kind: "folder" as const })),
      ...data.value.requests
        .filter(
          (r) => r.collectionId === node.collectionId && r.folderId === parent,
        )
        .map((r) => ({ ...r, kind: "request" as const })),
    ]
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((n) => ({ id: n.id, kind: n.kind }));
  }
  async function moveSibling(item: TreeRef, delta: number) {
    const items = siblings(item);
    const index = items.findIndex((i) => i.id === item.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= items.length) return;
    items.splice(index, 1);
    items.splice(target, 0, item);
    try {
      await reorderSiblings(item, items);
      notifications.success("Order updated successfully");
    } catch (error) {
      notifications.error("Failed to update order");
      throw error;
    }
  }
  async function reorderSiblings(item: TreeRef, items: TreeRef[]) {
    if (unchangedOrder(item, items)) return;
    const node =
      item.kind === "folder"
        ? data.value.folders.find((x) => x.id === item.id)
        : item.kind === "request"
          ? data.value.requests.find((x) => x.id === item.id)
          : null;
    await backend().reorderItems({
      collectionId: node?.collectionId ?? null,
      parentId: node
        ? "parentId" in node
          ? node.parentId
          : node.folderId
        : null,
      items,
    });
    for (const [position, ref] of items.entries()) {
      const list =
        ref.kind === "collection"
          ? data.value.collections
          : ref.kind === "folder"
            ? data.value.folders
            : data.value.requests;
      const target = list.find((n) => n.id === ref.id);
      if (target) target.position = position;
    }
  }
  function unchangedOrder(item: TreeRef, items: TreeRef[]) {
    const current = siblings(item);
    return current.length === items.length && current.every((node, index) =>
      node.id === items[index]?.id && node.kind === items[index]?.kind);
  }
  function unchangedParent(item: TreeRef, parentId: string | null) {
    if (item.kind === "collection") return true;
    return item.kind === "folder"
      ? data.value.folders.find(node => node.id === item.id)?.parentId === parentId
      : data.value.requests.find(node => node.id === item.id)?.folderId === parentId;
  }
  async function moveToFolder(item: TreeRef, parentId: string | null) {
    if (unchangedParent(item, parentId)) return;
    if (item.kind === "folder") {
      const node = data.value.folders.find((f) => f.id === item.id);
      if (!node) throw new DataError("NOT_FOUND", "This folder no longer exists.");
      const updated = await backend().updateFolder({
        id: item.id,
        name: node.name,
        parentId,
      });
      data.value.folders = data.value.folders.map((f) =>
        f.id === item.id ? updated : f,
      );
    }
    if (item.kind === "request") {
      await changeMetadata(item.id, { folderId: parentId });
    }
  }
  function selectedEnvironment(collectionId: string | null) {
    const selected = data.value.environmentSelections.find(s => s.collectionId === collectionId)?.environmentId;
    return data.value.environments.find(e => e.id === selected && e.collectionId === collectionId);
  }
  function variablesFor(collectionId: string | null) {
    return environmentVariables(data.value, collectionId);
  }
  function unchangedEnvironment(input: EnvironmentInput) {
    const current = data.value.environments.find(env => env.id === input.id);
    return current && environmentContent(current) === environmentContent(input) ? current : undefined;
  }
  async function saveEnvironment(input: EnvironmentInput) {
    if (environmentBusy.value) throw new DataError("BUSY", "Wait for the current environment change.");
    const current = unchangedEnvironment(input);
    if (current) return clone(current);
    environmentBusy.value = true;
    try {
      const environment = await backend().saveEnvironment(clone(input));
      const index = data.value.environments.findIndex(e => e.id === environment.id);
      if (index < 0) data.value.environments.push(environment);
      else data.value.environments[index] = environment;
      return environment;
    } finally { environmentBusy.value = false; }
  }
  async function deleteEnvironment(id: string) {
    if (environmentBusy.value) throw new DataError("BUSY", "Wait for the current environment change.");
    environmentBusy.value = true;
    try {
      await backend().deleteEnvironment(id);
      data.value.environments = data.value.environments.filter(e => e.id !== id);
      for (const selection of data.value.environmentSelections)
        if (selection.environmentId === id) selection.environmentId = null;
    } finally { environmentBusy.value = false; }
  }
  async function selectEnvironment(collectionId: string | null, environmentId: string | null) {
    if (environmentBusy.value) throw new DataError("BUSY", "Wait for the current environment change.");
    if ((selectedEnvironment(collectionId)?.id ?? null) === environmentId) return;
    environmentBusy.value = true;
    try {
      const selected = await backend().selectEnvironment({ collectionId, environmentId });
      data.value.environmentSelections = data.value.environmentSelections.filter(s => s.collectionId !== collectionId);
      data.value.environmentSelections.push(selected);
    } finally { environmentBusy.value = false; }
  }
  async function pickAttachment() {
    const result = await backend().pickAttachment();
    if (result) attachments[result.id] = result;
    return result;
  }
  return {
    data,
    tabs,
    tabIds,
    activeId,
    active,
    activeCollectionId,
    selectedCollectionId,
    ready,
    loading,
    error,
    sessionError,
    attachments,
    dirty,
    dirtyIds,
    hasDirty,
    initialize,
    open,
    activate,
    save,
    discard,
    reloadSaved,
    closeClean,
    reorderTabs,
    nextTab,
    createCollection: notifyMutation(createCollection, () => ({ success: "Collection created successfully", error: "Failed to create collection" })),
    applyImportedCollection,
    createFolder: notifyMutation(createFolder, () => ({ success: "Folder created successfully", error: "Failed to create folder" })),
    createRequest: notifyMutation(createRequest, () => ({ success: "Request created successfully", error: "Failed to create request" })),
    cloneRequest: notifyMutation(cloneRequest, () => ({ success: "Request cloned successfully", error: "Failed to clone request" })),
    rename: notifyMutation(rename, (item, name) => ({ success: unchangedName(item, name) ? null : `${item.kind[0]!.toUpperCase()}${item.kind.slice(1)} renamed successfully`, error: `Failed to rename ${item.kind}` })),
    descendants,
    remove,
    siblings,
    moveSibling,
    reorderSiblings: notifyMutation(reorderSiblings, (item, items) => ({ success: unchangedOrder(item, items) ? null : "Order updated successfully", error: "Failed to update order" })),
    moveToFolder: notifyMutation(moveToFolder, (item, parentId) => ({ success: unchangedParent(item, parentId) ? null : `${item.kind === "folder" ? "Folder" : "Request"} moved successfully`, error: `Failed to move ${item.kind}` })),
    environmentBusy,
    transitioning,
    pendingOperations,
    beginWorkspaceTransition,
    applyWorkspace,
    endWorkspaceTransition,
    selectedEnvironment,
    variablesFor,
    saveEnvironment: notifyMutation(saveEnvironment, input => ({ success: unchangedEnvironment(input) ? null : input.id ? "Environment saved successfully" : "Environment created successfully", error: input.id ? "Failed to save environment" : "Failed to create environment" })),
    deleteEnvironment,
    selectEnvironment: notifyMutation(selectEnvironment, (collectionId, environmentId) => ({ success: (selectedEnvironment(collectionId)?.id ?? null) === environmentId ? null : "Environment selection updated", error: "Failed to select environment" })),
    pickAttachment,
    updateView,
    cacheEditor,
    persistSession,
  };
});
