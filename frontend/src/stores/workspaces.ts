import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { nativeWorkspacesApi, type WorkspaceCatalog, type WorkspacesApi } from "../services/workspaces";
import { DataError, errorMessage } from "../services/data";
import { useWorkspaceStore } from "./workspace";
import { useExecutionStore } from "./execution";
import { useNotificationsStore } from "./notifications";

export const useWorkspacesStore = defineStore("workspaces", () => {
  const catalog = ref<WorkspaceCatalog | null>(null);
  const busy = ref(false);
  const creating = ref(false);
  const managing = ref(false);
  const deletingId = ref<string | null>(null);
  let returnToManager = false;
  const draftName = ref("Untitled Workspace");
  const failure = ref("");
  const needsRecovery = ref(false);
  const workspace = useWorkspaceStore();
  const executions = useExecutionStore();
  const notifications = useNotificationsStore();
  const activeName = computed(() => catalog.value?.workspaces.find(entry => entry.id === catalog.value?.activeId)?.name ?? "My Workspace");
  let api: WorkspacesApi = nativeWorkspacesApi;
  async function initialize(service: WorkspacesApi = nativeWorkspacesApi) {
    api = service;
    catalog.value = await api.list();
  }
  function beginCreate() {
    if (busy.value || needsRecovery.value || !catalog.value) return;
    if (!workspace.ready || workspace.loading || workspace.pendingOperations || workspace.environmentBusy) {
      notifications.error("Wait for current operations to finish before creating a workspace.");
      return;
    }
    if (workspace.hasDirty || executions.activeIds.length) {
      notifications.error(workspace.hasDirty
        ? "Save or discard request changes before creating a workspace."
        : "Wait for running requests to finish before creating a workspace.");
      return;
    }
    draftName.value = "Untitled Workspace";
    failure.value = "";
    returnToManager = managing.value;
    managing.value = false;
    creating.value = true;
  }
  function cancelCreate() {
    if (busy.value || needsRecovery.value) return;
    creating.value = false;
    managing.value = returnToManager;
    returnToManager = false;
    failure.value = "";
  }
  async function change(id?: string): Promise<boolean> {
    if (busy.value || needsRecovery.value || !catalog.value || (!id && !creating.value)) return false;
    if (id === catalog.value.activeId) { managing.value = false; return true; }
    busy.value = true;
    failure.value = "";
    let locked = false;
    let submitted = false;
    try {
      if (executions.activeIds.length) throw new Error("Wait for running requests to finish before changing workspaces.");
      if (!id && (!draftName.value.trim() || [...draftName.value.trim()].length > 200
        || [...draftName.value].some(character => character.charCodeAt(0) < 32 || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)))) {
        throw new Error("Use a workspace name between 1 and 200 characters without control characters.");
      }
      await workspace.beginWorkspaceTransition();
      locked = true;
      submitted = true;
      const result = id ? await api.select(id) : await api.create(draftName.value.trim());
      if (id && result.catalog.activeId !== id) throw new DataError("INVALID_RESPONSE", "The desktop returned a different workspace. Reload the active workspace before editing.");
      workspace.applyWorkspace(result.workspace, result.documents);
      // Completed responses belong to the old workspace and must not bleed into another.
      for (const key of Object.keys(executions.states)) delete executions.states[key];
      catalog.value = result.catalog;
      creating.value = false;
      managing.value = false;
      returnToManager = false;
      if (!id) notifications.success("Workspace created successfully");
      return true;
    } catch (error) {
      // A lost/malformed IPC response can occur after native selection commits.
      // Freeze writes until the authoritative active workspace is reloaded.
      if (submitted && (!(error instanceof DataError) || ["IPC_ERROR", "INVALID_RESPONSE"].includes(error.code))) {
        needsRecovery.value = true;
      }
      failure.value = errorMessage(error);
      notifications.error(failure.value);
      return false;
    } finally {
      if (locked && !needsRecovery.value) workspace.endWorkspaceTransition();
      busy.value = false;
    }
  }
  async function manage(action: "default" | "delete", id: string): Promise<boolean> {
    if (busy.value || needsRecovery.value || !catalog.value || creating.value) return false;
    if (action === "default" && id === catalog.value.defaultId) return true;
    if (action === "delete" && id !== deletingId.value) return false;
    busy.value = true;
    failure.value = "";
    let locked = false;
    let submitted = false;
    try {
      if (action === "delete" && id === catalog.value.defaultId) throw new Error("The default workspace cannot be deleted.");
      if (executions.activeIds.length) throw new Error("Wait for running requests to finish before managing workspaces.");
      await workspace.beginWorkspaceTransition();
      locked = true;
      submitted = true;
      if (action === "default") {
        const result = await api.setDefault(id);
        if (result.defaultId !== id || result.activeId !== catalog.value.activeId) {
          throw new DataError("INVALID_RESPONSE", "Workspace settings changed unexpectedly. Reload the active workspace.");
        }
        catalog.value = result;
        notifications.success("Default workspace updated");
      } else {
        const result = await api.remove(id);
        if (result.catalog.workspaces.some(entry => entry.id === id)
          || (!result.activation && result.catalog.activeId !== catalog.value.activeId)) {
          throw new DataError("INVALID_RESPONSE", "Workspace deletion could not be verified. Reload the active workspace.");
        }
        if (result.activation) {
          workspace.applyWorkspace(result.activation.workspace, result.activation.documents);
          for (const key of Object.keys(executions.states)) delete executions.states[key];
        }
        catalog.value = result.catalog;
        deletingId.value = null;
        notifications.success("Workspace deleted. Stored data was kept for recovery.");
      }
      return true;
    } catch (error) {
      if (submitted && (!(error instanceof DataError) || ["IPC_ERROR", "INVALID_RESPONSE"].includes(error.code))) {
        needsRecovery.value = true;
        deletingId.value = null;
      }
      failure.value = errorMessage(error);
      notifications.error(failure.value);
      return false;
    } finally {
      if (locked && !needsRecovery.value) workspace.endWorkspaceTransition();
      busy.value = false;
    }
  }
  async function recover() {
    if (busy.value || !needsRecovery.value) return;
    busy.value = true;
    try {
      const current = await api.list();
      const result = await api.select(current.activeId);
      if (result.catalog.activeId !== current.activeId) throw new DataError("INVALID_RESPONSE", "The active workspace changed again. Please retry.");
      workspace.applyWorkspace(result.workspace, result.documents);
      for (const key of Object.keys(executions.states)) delete executions.states[key];
      catalog.value = result.catalog;
      creating.value = false;
      failure.value = "";
      needsRecovery.value = false;
      workspace.endWorkspaceTransition();
    } catch (error) { failure.value = errorMessage(error); }
    finally { busy.value = false; }
  }
  return { catalog, busy, creating, managing, deletingId, manage, draftName, failure, activeName, needsRecovery, recover, initialize, beginCreate, cancelCreate, change };
});
