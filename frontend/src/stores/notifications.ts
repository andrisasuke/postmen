import { onScopeDispose, ref } from "vue";
import { defineStore } from "pinia";

export type ToastKind = "success" | "error";
type PauseReason = "pointer" | "focus";
export interface Toast { id: number; kind: ToastKind; message: string }
interface Lifetime {
  handle?: ReturnType<typeof setTimeout>;
  remaining: number;
  started: number;
  paused: Set<PauseReason>;
}

export const useNotificationsStore = defineStore("notifications", () => {
  const items = ref<Toast[]>([]);
  const lifetimes = new Map<number, Lifetime>();
  let sequence = 0;

  function dismiss(id: number) {
    const lifetime = lifetimes.get(id);
    if (lifetime?.handle !== undefined) clearTimeout(lifetime.handle);
    lifetimes.delete(id);
    items.value = items.value.filter(item => item.id !== id);
  }
  function arm(id: number, lifetime: Lifetime) {
    if (lifetime.handle !== undefined) clearTimeout(lifetime.handle);
    lifetime.handle = undefined;
    if (lifetime.paused.size) return;
    lifetime.started = Date.now();
    lifetime.handle = setTimeout(() => dismiss(id), lifetime.remaining);
  }
  function show(kind: ToastKind, message: string) {
    const existing = items.value.find(item => item.kind === kind && item.message === message);
    const id = existing?.id ?? ++sequence;
    const lifetime = lifetimes.get(id) ?? { remaining: 0, started: 0, paused: new Set<PauseReason>() };
    lifetime.remaining = kind === "success" ? 3500 : 6000;
    lifetimes.set(id, lifetime);
    if (!existing) items.value.push({ id, kind, message });
    while (items.value.length > 3) dismiss(items.value[0]!.id);
    arm(id, lifetime);
    return id;
  }
  function pause(id: number, reason: PauseReason) {
    const lifetime = lifetimes.get(id);
    if (!lifetime || lifetime.paused.has(reason)) return;
    if (!lifetime.paused.size) {
      lifetime.remaining = Math.max(0, lifetime.remaining - (Date.now() - lifetime.started));
      if (lifetime.handle !== undefined) clearTimeout(lifetime.handle);
      lifetime.handle = undefined;
    }
    lifetime.paused.add(reason);
  }
  function resume(id: number, reason: PauseReason) {
    const lifetime = lifetimes.get(id);
    if (!lifetime || !lifetime.paused.delete(reason) || lifetime.paused.size) return;
    arm(id, lifetime);
  }
  function clear() {
    for (const id of lifetimes.keys()) dismiss(id);
  }
  onScopeDispose(clear);
  return {
    items, dismiss, pause, resume, clear,
    success: (message: string) => show("success", message),
    error: (message: string) => show("error", message),
  };
});
