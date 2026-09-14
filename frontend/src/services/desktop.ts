import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isShellAction } from "../types/shell";
import type { BootstrapInfo, ThemeMode, ShellAction } from "../types/shell";

export const isDesktop = () => isTauri();

export function parseBootstrap(value: unknown): BootstrapInfo {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid desktop bootstrap response");
  const info = value as Record<string, unknown>;
  if (
    info.schemaVersion !== 5 ||
    typeof info.name !== "string" ||
    typeof info.version !== "string" ||
    typeof info.platform !== "string" ||
    info.milestone !== "M4" ||
    info.databaseReady !== true ||
    info.httpReady !== true
  ) {
    throw new Error("Incompatible desktop IPC contract");
  }
  return info as unknown as BootstrapInfo;
}

export async function bootstrapDesktop(): Promise<BootstrapInfo | null> {
  if (!isDesktop()) return null; // Browser preview is not evidence of a native IPC connection.
  return parseBootstrap(await invoke<unknown>("bootstrap_app"));
}

export async function onShellAction(
  callback: (action: ShellAction) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return listen<unknown>("shell-action", ({ payload }) => {
    if (isShellAction(payload)) callback(payload);
  });
}

export async function setWindowTheme(theme: ThemeMode): Promise<void> {
  // Forcing the currently resolved color would pin NSAppearance and prevent
  // prefers-color-scheme from following later OS changes in System mode.
  if (isDesktop())
    await getCurrentWindow().setTheme(theme === "system" ? null : theme);
}

export async function startTitlebarDrag(): Promise<void> {
  if (isDesktop()) await invoke("start_titlebar_drag");
}

export async function windowControl(
  action: "minimize" | "maximize" | "close",
): Promise<void> {
  if (!isDesktop()) return;
  const window = getCurrentWindow();
  if (action === "minimize") await window.minimize();
  else if (action === "maximize") await window.toggleMaximize();
  else await window.close();
}
