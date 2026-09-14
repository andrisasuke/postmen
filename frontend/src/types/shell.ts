export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<ThemeMode, "system">;
export type Orientation = "horizontal" | "vertical";
export type ShellAction =
  | "about"
  | "toggle-sidebar"
  | "toggle-layout"
  | "reset-layout"
  | "save-request"
  | "send-request"
  | "request-quit"
  | "close-request"
  | "next-request"
  | "previous-request";
export interface BootstrapInfo {
  schemaVersion: 5;
  name: string;
  version: string;
  platform: string;
  milestone: "M4";
  databaseReady: true;
  httpReady: true;
}
export interface KeyValueRow {
  id: string;
  enabled: boolean;
  name: string;
  value: string;
  description: string;
}
export const methods = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
export type HttpMethod = (typeof methods)[number];
export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  shortcut?: string;
}

export function isShellAction(value: unknown): value is ShellAction {
  return (
    typeof value === "string" &&
    [
      "about",
      "toggle-sidebar",
      "toggle-layout",
      "reset-layout",
      "save-request",
      "send-request",
      "request-quit",
      "close-request",
      "next-request",
      "previous-request",
    ].includes(value)
  );
}
