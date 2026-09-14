import { z } from "zod";
import { call } from "./data";
import { requestSchema, workspaceSchema } from "../types/data";

export const workspaceCatalogSchema = z.object({
  version: z.literal(1),
  activeId: z.string().uuid(),
  defaultId: z.string().uuid(),
  workspaces: z.array(z.object({ id: z.string().uuid(), name: z.string() })).min(1).max(100),
}).refine(value => value.workspaces.some(entry => entry.id === value.activeId)
  && value.workspaces.some(entry => entry.id === value.defaultId)
  && new Set(value.workspaces.map(entry => entry.id)).size === value.workspaces.length);
export const workspaceActivationSchema = z.object({
  catalog: workspaceCatalogSchema,
  workspace: workspaceSchema,
  documents: z.array(requestSchema).max(100),
}).refine(value => value.workspace.session.tabIds.every(id => value.documents.some(doc => doc.id === id)));
export type WorkspaceCatalog = z.infer<typeof workspaceCatalogSchema>;
export type WorkspaceActivation = z.infer<typeof workspaceActivationSchema>;
export const workspaceRemovalSchema = z.object({ catalog: workspaceCatalogSchema, activation: workspaceActivationSchema.nullable() })
  .refine(value => !value.activation || value.activation.catalog.activeId === value.catalog.activeId);
export type WorkspaceRemoval = z.infer<typeof workspaceRemovalSchema>;
export interface WorkspacesApi {
  list(): Promise<WorkspaceCatalog>;
  create(name: string): Promise<WorkspaceActivation>;
  select(id: string): Promise<WorkspaceActivation>;
  setDefault(id: string): Promise<WorkspaceCatalog>;
  remove(id: string): Promise<WorkspaceRemoval>;
}
export const nativeWorkspacesApi: WorkspacesApi = {
  list: () => call("list_workspaces", {}, workspaceCatalogSchema),
  create: name => call("create_workspace", { name }, workspaceActivationSchema),
  select: id => call("select_workspace", { id }, workspaceActivationSchema),
  setDefault: id => call("set_default_workspace", { id }, workspaceCatalogSchema),
  remove: id => call("delete_workspace", { id }, workspaceRemovalSchema),
};
