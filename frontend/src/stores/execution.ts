import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import { clone } from "../types/data";
import type { RequestDoc } from "../types/data";
import type { ExecutionApi, ExecutionResult } from "../types/execution";
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
}
export const useExecutionStore = defineStore("execution", () => {
  const states = reactive<Record<string, RequestExecution>>({});
  const ready = ref(false);
  const timeoutMs = ref(30000);
  const activeIds = computed(() =>
    Object.keys(states).filter((id) => states[id]?.phase !== "done"),
  );
  let api: ExecutionApi | null = null;
  const pending = new Map<string, Promise<void>>();
  const prepared = new Map<string, Promise<void>>();
  function initialize(service: ExecutionApi) {
    api = service;
    ready.value = true;
  }
  async function send(doc: RequestDoc): Promise<void> {
    if (!api || (states[doc.id] && states[doc.id]?.phase !== "done")) return;
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
  async function forget(id: string) {
    await cancel(id);
    delete states[id];
  }
  return {
    states,
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
