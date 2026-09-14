import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { useExecutionStore } from "./execution";
import { createMemoryApi } from "../fixtures/memory-api";
import { createExecutionFixture } from "../fixtures/execution-api";
import type {
  ExecutionApi,
  ExecutionResult,
  PrepareExecution,
} from "../types/execution";
import type { RequestDoc } from "../types/data";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("M3 execution state", () => {
  let pinia: ReturnType<typeof createPinia>,
    store: ReturnType<typeof useExecutionStore>,
    doc: RequestDoc;
  beforeEach(async () => {
    pinia = createPinia();
    setActivePinia(pinia);
    store = useExecutionStore();
    const data = createMemoryApi();
    const c = await data.createCollection("QA");
    doc = await data.createRequest({
      collectionId: c.id,
      folderId: null,
      name: "First",
    });
    doc.url = "http://fixture.test/json";
  });
  afterEach(() => {
    disposePinia(pinia);
    vi.useRealTimers();
  });
  it("does not send in unconnected browser preview", async () => {
    await store.send(doc);
    expect(store.states).toEqual({});
  });
  it("snapshots draft without saving and suppresses duplicate sends", async () => {
    vi.useFakeTimers();
    const api = createExecutionFixture();
    const prepare = vi.spyOn(api, "prepare");
    store.initialize(api);
    doc.body = "at-send";
    const sending = store.send(doc);
    doc.body = "edited-after";
    await store.send(doc);
    await vi.runAllTimersAsync();
    await sending;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]![0].request.body).toBe("at-send");
    expect(store.states[doc.id]!.result?.body).toContain("at-send");
    expect(doc.body).toBe("edited-after");
  });
  it("cancels before prepare completes and waits for execution acknowledgment", async () => {
    const gate = deferred<void>();
    const fixture = createExecutionFixture();
    const events: string[] = [];
    const api: ExecutionApi = {
      prepare: async (input) => {
        await gate.promise;
        events.push("prepare");
        await fixture.prepare(input);
      },
      cancel: async (id) => {
        events.push("cancel");
        await fixture.cancel(id);
      },
      execute: async (id) => {
        events.push("execute");
        return fixture.execute(id);
      },
    };
    store.initialize(api);
    const sending = store.send(doc);
    const cancelling = store.cancel(doc.id);
    expect(store.states[doc.id]!.phase).toBe("cancelling");
    gate.resolve();
    await Promise.all([sending, cancelling]);
    expect(events.indexOf("cancel")).toBeLessThan(events.indexOf("execute"));
    expect(store.states[doc.id]!.result?.outcome).toBe("cancelled");
    expect(store.activeIds).toEqual([]);
  });
  it("keeps independent concurrent tabs and allows resend after cancellation", async () => {
    vi.useFakeTimers();
    store.initialize(createExecutionFixture());
    const other = {
      ...doc,
      id: crypto.randomUUID(),
      url: "http://fixture.test/json",
    };
    doc.url = "http://fixture.test/slow";
    const a = store.send(doc),
      b = store.send(other);
    const first = store.states[doc.id]!.executionId;
    await store.cancel(doc.id);
    await vi.runAllTimersAsync();
    await Promise.all([a, b]);
    expect(store.states[other.id]!.result?.status).toBe(200);
    expect(store.states[doc.id]!.result?.outcome).toBe("cancelled");
    doc.url = "http://fixture.test/json";
    const again = store.send(doc);
    await vi.runAllTimersAsync();
    await again;
    expect(store.states[doc.id]!.executionId).not.toBe(first);
    expect(store.states[doc.id]!.result?.status).toBe(200);
  });
  it("ignores mismatched response identity", async () => {
    vi.useFakeTimers();
    const fixture = createExecutionFixture();
    store.initialize({
      ...fixture,
      execute: async (id) => ({
        ...(await fixture.execute(id)),
        executionId: crypto.randomUUID(),
      }),
    });
    const sending = store.send(doc);
    await vi.runAllTimersAsync();
    await sending;
    expect(store.states[doc.id]!.result).toBeNull();
    expect(store.states[doc.id]!.failure).toContain("ignored");
  });
  it("never lets a stale completion overwrite a newer slot", async () => {
    const result = deferred<ExecutionResult>();
    let input!: PrepareExecution;
    store.initialize({
      prepare: async (value) => {
        input = value;
      },
      execute: () => result.promise,
      cancel: async () => {},
    });
    const sending = store.send(doc);
    await Promise.resolve();
    const current = {
      ...store.states[doc.id]!,
      executionId: crypto.randomUUID(),
      failure: "newer",
    };
    store.states[doc.id] = current;
    result.resolve({
      executionId: input.executionId,
      requestId: doc.id,
      outcome: "success",
      status: 200,
      statusText: "OK",
      headers: [],
      headersTruncated: false,
      body: "old",
      bodyEncoding: "UTF-8",
      binary: false,
      previewBytes: 3,
      truncated: false,
      durationMs: 1,
      errorCode: null,
      message: null,
      historyWarning: null,
    });
    await sending;
    expect(store.states[doc.id]!.failure).toBe("newer");
    expect(store.states[doc.id]!.result).toBeNull();
  });
  it("cleans up a reservation after transport failure", async () => {
    const cancel = vi.fn(async () => {});
    store.initialize({
      prepare: async () => {},
      execute: async () => {
        throw new Error("IPC interrupted");
      },
      cancel,
    });
    await store.send(doc);
    expect(cancel).toHaveBeenCalledWith(store.states[doc.id]!.executionId);
    expect(store.states[doc.id]!.failure).toBe("IPC interrupted");
    expect(store.activeIds).toEqual([]);
  });
  it("closing a running tab waits for cancellation before forgetting its state", async () => {
    store.initialize(createExecutionFixture());
    doc.url = "http://fixture.test/slow";
    const sending = store.send(doc);
    await store.forget(doc.id);
    await sending;
    expect(store.states[doc.id]).toBeUndefined();
  });
});
