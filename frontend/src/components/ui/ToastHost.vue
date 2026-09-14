<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { useNotificationsStore } from "../../stores/notifications";
import AppIcon from "./AppIcon.vue";
import IconButton from "./IconButton.vue";

const notifications = useNotificationsStore();
function leaveFocus(id: number, event: FocusEvent) {
  if (event.currentTarget instanceof HTMLElement && event.relatedTarget instanceof Node
    && event.currentTarget.contains(event.relatedTarget)) return;
  notifications.resume(id, "focus");
}
onBeforeUnmount(() => notifications.clear());
</script>

<template>
  <Teleport to="body">
    <TransitionGroup name="toast" tag="div" class="toast-region" aria-label="Notifications">
      <div v-for="toast in notifications.items" :key="toast.id" class="toast-card" :class="`toast-${toast.kind}`"
        :role="toast.kind === 'error' ? 'alert' : 'status'" aria-atomic="true"
        @pointerenter="notifications.pause(toast.id, 'pointer')" @pointerleave="notifications.resume(toast.id, 'pointer')"
        @focusin="notifications.pause(toast.id, 'focus')" @focusout="leaveFocus(toast.id, $event)">
        <span class="toast-status-icon"><AppIcon :name="toast.kind === 'success' ? 'check' : 'x'" :size="14" :stroke="3" /></span>
        <span class="toast-message">{{ toast.message }}</span>
        <IconButton class="toast-dismiss" icon="x" label="Dismiss notification" @pointerdown.prevent @click="notifications.dismiss(toast.id)" />
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<style>
.toast-region { position: fixed; top: calc(var(--titlebar-height) + 12px); left: 50%; transform: translateX(-50%); z-index: 200; display: flex; flex-direction: column; align-items: center; gap: 8px; width: max-content; max-width: calc(100vw - 32px); pointer-events: none; }
.toast-card { display: flex; align-items: center; gap: 10px; max-width: 100%; padding: 10px 12px; border-radius: 10px; background: var(--toast-bg); color: var(--text); box-shadow: 0 5px 18px rgb(0 0 0 / 18%); font: 500 13px/20px var(--font-ui); pointer-events: auto; }
.toast-status-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 20px; width: 20px; height: 20px; border-radius: 50%; color: #fff; }
.toast-success .toast-status-icon { background: var(--toast-success); }
.toast-error .toast-status-icon { background: var(--toast-error); }
.toast-message { min-width: 0; overflow-wrap: anywhere; }
.toast-card .toast-dismiss { flex-shrink: 0; width: 20px; height: 20px; min-width: 20px; color: var(--muted); }
.toast-enter-active, .toast-leave-active, .toast-move { transition: opacity 160ms ease, transform 160ms ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-6px); }
@media (prefers-reduced-motion: reduce) { .toast-enter-active, .toast-leave-active, .toast-move { transition: none; } }
</style>
