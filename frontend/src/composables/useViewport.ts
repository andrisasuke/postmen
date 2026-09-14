import { onMounted, onUnmounted, ref } from "vue";

export function useViewport() {
  const width = ref(window.innerWidth);
  const height = ref(window.innerHeight);
  const update = () => {
    width.value = window.innerWidth;
    height.value = window.innerHeight;
  };
  onMounted(() => window.addEventListener("resize", update));
  onUnmounted(() => window.removeEventListener("resize", update));
  return { width, height };
}
