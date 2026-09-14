// DEV-only deterministic execution test double. No actual network/SQLite.
import type {
  ExecutionApi,
  ExecutionResult,
  PrepareExecution,
} from "../types/execution";
import { clone } from "../types/data";
import { resolveRequest } from "../services/variables";
import { useWorkspaceStore } from "../stores/workspace";
export function createExecutionFixture(): ExecutionApi {
  const entries = new Map<
    string,
    { input: PrepareExecution; cancelled: boolean; wake: (() => void) | null }
  >();
  return {
    async prepare(input) {
      const snapshot = clone(input);
      snapshot.request = resolveRequest(snapshot.request, useWorkspaceStore().variablesFor(snapshot.request.collectionId));
      entries.set(input.executionId, {
        input: snapshot,
        cancelled: false,
        wake: null,
      });
    },
    async cancel(id) {
      const entry = entries.get(id);
      if (entry) {
        entry.cancelled = true;
        entry.wake?.();
      }
    },
    async execute(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error("Unprepared fixture");
      const url = entry.input.request.url;
      const started = Date.now();
      if (!entry.cancelled)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, url.includes("slow") ? 15000 : 50);
          entry.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      const body = url.includes("html")
        ? "<script>globalThis.injected=true</script><img src=x onerror=alert(1)>"
        : url.includes("empty")
          ? ""
          : JSON.stringify({
              fixture: true,
              path: url,
              body: entry.input.request.body,
              name: "日本語",
            });
      const result: ExecutionResult = {
        executionId: id,
        requestId: entry.input.request.id,
        outcome: entry.cancelled
          ? "cancelled"
          : url.includes("timeout")
            ? "error"
            : "success",
        status:
          entry.cancelled || url.includes("timeout")
            ? null
            : url.includes("error")
              ? 500
              : url.includes("empty")
                ? 204
                : 200,
        statusText: url.includes("error") ? "Internal Server Error" : "OK",
        headers: [
          { name: "x-repeat", value: "first" },
          { name: "x-repeat", value: "second" },
        ],
        headersTruncated: false,
        body,
        bodyEncoding: "UTF-8",
        binary: false,
        previewBytes: new TextEncoder().encode(body).length,
        truncated: url.includes("large"),
        durationMs: Date.now() - started,
        errorCode: entry.cancelled
          ? "CANCELLED"
          : url.includes("timeout")
            ? "TIMEOUT"
            : null,
        message: entry.cancelled
          ? "Client request cancelled. The server may already have processed it."
          : url.includes("timeout")
            ? "The request timed out."
            : null,
        historyWarning: url.includes("history-failure")
          ? "History fixture could not be saved; response kept."
          : null,
      };
      entries.delete(id);
      return result;
    },
  };
}
