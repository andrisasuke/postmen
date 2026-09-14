import { z } from "zod";
import { methods } from "./shell";

const id = z.string().uuid();
const position = z.number().int().nonnegative();
export const collectionSchema = z.object({
  id,
  name: z.string(),
  position,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export const folderSchema = z.object({
  id,
  collectionId: id,
  parentId: id.nullable(),
  name: z.string(),
  position,
});
export const keyValueSchema = z.object({
  id,
  enabled: z.boolean(),
  name: z.string(),
  value: z.string(),
  description: z.string(),
});
export const environmentSchema = z.object({
  id,
  collectionId: id.nullable(),
  name: z.string(),
  variables: z.array(keyValueSchema),
  revision: z.number().int().positive(),
});
export const environmentSelectionSchema = z.object({
  collectionId: id.nullable(),
  environmentId: id.nullable(),
});
export const formFieldSchema = z.object({
  id,
  enabled: z.boolean(),
  name: z.string(),
  kind: z.enum(["text", "file"]),
  value: z.string(),
  attachmentId: id.nullable(),
  description: z.string(),
});
export const attachmentSchema = z.object({
  id,
  name: z.string(),
  size: z.number().int().nonnegative(),
});
export const requestSchema = z.object({
  id,
  collectionId: id,
  folderId: id.nullable(),
  name: z.string(),
  method: z.enum(methods),
  url: z.string(),
  bodyKind: z.enum(["none", "json", "multipart"]),
  body: z.string(),
  params: z.array(keyValueSchema),
  headers: z.array(keyValueSchema),
  formData: z.array(formFieldSchema),
  position,
  revision: z.number().int().positive(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export const summarySchema = requestSchema.pick({
  id: true,
  collectionId: true,
  folderId: true,
  name: true,
  method: true,
  position: true,
  revision: true,
});
export const paneSchema = z.object({
  orientation: z.enum(["horizontal", "vertical"]),
  requestWidth: z.number().nullable(),
  requestHeight: z.number(),
  requestCollapsed: z.boolean(),
  responseCollapsed: z.boolean(),
});
export const viewSchema = z.object({
  section: z.enum(["params", "body", "headers"]),
  selection: z.object({ anchor: position, head: position }),
  scroll: z.object({
    top: z.number().nonnegative(),
    left: z.number().nonnegative(),
  }),
  pane: paneSchema,
});
export const sessionSchema = z.object({
  tabIds: z.array(id),
  activeId: id.nullable(),
  views: z.record(id, viewSchema),
});
export const workspaceSchema = z.object({
  attachments: z.array(attachmentSchema),
  collections: z.array(collectionSchema),
  folders: z.array(folderSchema),
  requests: z.array(summarySchema),
  environments: z.array(environmentSchema),
  environmentSelections: z.array(environmentSelectionSchema),
  session: sessionSchema,
  warnings: z.array(z.string()),
});

export type Collection = z.infer<typeof collectionSchema>;
export type Folder = z.infer<typeof folderSchema>;
export type Environment = z.infer<typeof environmentSchema>;
export type EnvironmentSelection = z.infer<typeof environmentSelectionSchema>;
export type RequestDoc = z.infer<typeof requestSchema>;
export type NewRequestContent = Pick<RequestDoc,
  "method" | "url" | "bodyKind" | "body" | "params" | "headers" | "formData"
>;
export type RequestSummary = z.infer<typeof summarySchema>;
export type FormField = z.infer<typeof formFieldSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type RequestView = z.infer<typeof viewSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type TreeKind = "collection" | "folder" | "request";
export interface TreeRef {
  kind: TreeKind;
  id: string;
}
export interface Parent {
  collectionId: string;
  parentId: string | null;
}
export interface ReorderInput {
  collectionId: string | null;
  parentId: string | null;
  items: TreeRef[];
}
export interface EnvironmentInput {
  id: string | null;
  collectionId: string | null;
  name: string;
  variables: Environment["variables"];
  revision: number | null;
}
export interface DataApi {
  loadWorkspace(): Promise<Workspace>;
  createCollection(name: string): Promise<Collection>;
  renameCollection(id: string, name: string): Promise<Collection>;
  deleteCollection(id: string): Promise<void>;
  createFolder(input: Parent & { name: string }): Promise<Folder>;
  updateFolder(input: {
    id: string;
    parentId: string | null;
    name: string;
  }): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;
  createRequest(input: {
    collectionId: string;
    folderId: string | null;
    name: string;
    content?: NewRequestContent;
  }): Promise<RequestDoc>;
  getRequest(id: string): Promise<RequestDoc>;
  saveRequest(input: RequestDoc): Promise<RequestDoc>;
  deleteRequest(id: string): Promise<void>;
  reorderItems(input: ReorderInput): Promise<void>;
  saveEnvironment(input: EnvironmentInput): Promise<Environment>;
  deleteEnvironment(id: string): Promise<void>;
  selectEnvironment(input: EnvironmentSelection): Promise<EnvironmentSelection>;
  saveSession(input: Session): Promise<Session>;
  pickAttachment(): Promise<Attachment | null>;
}
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const emptyWorkspace = (): Workspace => ({
  attachments: [],
  collections: [],
  folders: [],
  requests: [],
  environments: [],
  environmentSelections: [],
  session: { tabIds: [], activeId: null, views: {} },
  warnings: [],
});
export const newRow = () => ({
  id: crypto.randomUUID(),
  enabled: true,
  name: "",
  value: "",
  description: "",
});
export function newView(doc: RequestDoc): RequestView {
  return {
    section:
      doc.bodyKind !== "none" || doc.body.length > 0 || doc.formData.length > 0
        ? "body"
        : "params",
    selection: { anchor: 0, head: 0 },
    scroll: { top: 0, left: 0 },
    pane: {
      orientation: "horizontal",
      requestWidth: null,
      requestHeight: 380,
      requestCollapsed: false,
      responseCollapsed: false,
    },
  };
}
export function editable(doc: RequestDoc): string {
  const {
    name,
    folderId,
    method,
    url,
    bodyKind,
    body,
    params,
    headers,
    formData,
  } = doc;
  return JSON.stringify({
    name,
    folderId,
    method,
    url,
    bodyKind,
    body,
    params,
    headers,
    formData,
  });
}
