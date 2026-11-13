import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import { clone } from "../types/data";
import type { RequestDoc } from "../types/data";
import { lastExecutionSchema, type ExecutionApi, type ExecutionResult } from "../types/execution";
import { errorMessage } from "../services/data";
export interface RequestExecution {
  executionId: string;
  phase: "preparing" | "running" | "cancelling" | "done";
  startedAt: number;
  result: ExecutionResult | null;
  failure: string;
  section: "response" | "headers";
  format: "formatted" | "raw";
  cancelRequested: boolean;
  completedAt?: number;
}
export const useExecutionStore = defineStore("execution", () => {
  const states = reactive<Record<string, RequestExecution>>({});
  const restores = reactive<Record<string, { loading: boolean; error: string; checked: boolean }>>({});
  const ready = ref(false);
  const timeoutMs = ref(30000);
  const activeIds = computed(() =>
    Object.keys(states).filter((id) => states[id]?.phase !== "done"),
  );
  let api: ExecutionApi | null = null;
  const pending = new Map<string, Promise<void>>();
  const prepared = new Map<string, Promise<void>>();
  let workspaceGeneration = 0;
  const generations = new Map<string, number>();
  const restoring = new Map<string, Promise<void>>();
  function invalidate(id: string) {
    generations.set(id, (generations.get(id) ?? 0) + 1);
    restoring.delete(id);
    delete restores[id];
  }
  function resetWorkspace() {
    workspaceGeneration++;
    restoring.clear();
    generations.clear();
    for (const id of Object.keys(restores)) delete restores[id];
    for (const id of Object.keys(states)) delete states[id];
  }
  function initialize(service: ExecutionApi) {
    api = service;
    ready.value = true;
  }
  function restore(id: string, retry = false): Promise<void> {
    if (!api || states[id] || (!retry && restores[id]?.checked)) return Promise.resolve();
    const existing = restoring.get(id);
    if (existing) return existing;
    const service = api;
    const workspace = workspaceGeneration;
    const generation = generations.get(id) ?? 0;
    const current = () => workspace === workspaceGeneration && generation === (generations.get(id) ?? 0);
    restores[id] = { loading: true, error: "", checked: false };
    const operation = (async () => {
      try {
        const raw = await service.getLastExecution(id);
        const snapshot = lastExecutionSchema.nullable().parse(raw);
        if (!current()) return;
        if (snapshot && snapshot.result.requestId !== id) throw new Error("Saved execution request ID does not match.");
        if (snapshot) states[id] = { executionId: snapshot.result.executionId, phase: "done", startedAt: snapshot.completedAt, completedAt: snapshot.completedAt, result: snapshot.result, failure: "", section: "response", format: "formatted", cancelRequested: false };
        restores[id] = { loading: false, error: "", checked: true };
      } catch (error) {
        if (current()) restores[id] = { loading: false, error: errorMessage(error), checked: true };
      }
    })();
    restoring.set(id, operation);
    void operation.then(() => { if (restoring.get(id) === operation) restoring.delete(id); });
    return operation;
  }
  async function send(doc: RequestDoc): Promise<void> {
    if (!api || (states[doc.id] && states[doc.id]?.phase !== "done")) return;
    invalidate(doc.id);
    const service = api;
    const executionId = crypto.randomUUID();
    states[doc.id] = {
      executionId,
      phase: "preparing",
      startedAt: Date.now(),
      result: null,
      failure: "",
      section: "response",
      format: "formatted",
      cancelRequested: false,
    };
    const current = () =>
      states[doc.id]?.executionId === executionId ? states[doc.id] : undefined;
    const snapshot = clone(doc);
    const preparation = service.prepare({
      executionId,
      request: snapshot,
      timeoutMs: timeoutMs.value,
    });
    prepared.set(executionId, preparation);
    const operation = (async () => {
      try {
        await preparation;
        const state = current();
        if (state?.cancelRequested) await service.cancel(executionId);
        if (state)
          state.phase = state.cancelRequested ? "cancelling" : "running";
        const result = await service.execute(executionId);
        if (
          current() &&
          result.executionId === executionId &&
          result.requestId === doc.id
        )
          current()!.result = result;
        else if (current())
          current()!.failure =
            "An incompatible execution response was ignored.";
      } catch (e) {
        if (current()) current()!.failure = errorMessage(e);
        // An IPC/DTO error may happen after Rust registered the reservation.
        // Best-effort cancellation also makes an unstarted reservation safe to quit.
        await service.cancel(executionId).catch(() => {});
      } finally {
        if (current()) current()!.phase = "done";
        pending.delete(executionId);
        prepared.delete(executionId);
      }
    })();
    pending.set(executionId, operation);
    await operation;
  }
  async function cancel(id: string): Promise<void> {
    const state = states[id];
    if (!state || state.phase === "done" || !api) return;
    state.cancelRequested = true;
    state.phase = "cancelling";
    try {
      await prepared.get(state.executionId);
      await api.cancel(state.executionId);
      await pending.get(state.executionId);
    } catch (e) {
      state.failure = `Cancellation could not be confirmed: ${errorMessage(e)}`;
      throw e;
    }
  }
  async function cancelAll() {
    await Promise.all(activeIds.value.map(cancel));
  }
  function discard(id: string) {
    invalidate(id);
    delete states[id];
  }
  async function forget(id: string) {
    invalidate(id);
    await cancel(id);
    delete states[id];
  }
  return {
    states,
    restores,
    restore,
    resetWorkspace,
    discard,
    ready,
    timeoutMs,
    activeIds,
    initialize,
    send,
    cancel,
    cancelAll,
    forget,
  };
});
