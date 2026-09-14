// Development/browser test double only. This is NOT SQLite or native IPC.
import {
  clone,
  emptyWorkspace,
  workspaceSchema,
  requestSchema,
} from "../types/data";
import type { DataApi, RequestDoc, Workspace, TreeRef } from "../types/data";
import { DataError } from "../services/data";
import { validateEnvironment } from "../services/variables";
const key = "postmen.fixture.m2.v1";
export function createMemoryApi(persist = false): DataApi {
  let data: Workspace = emptyWorkspace();
  let requests: Record<string, RequestDoc> = {};
  if (persist) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          data: unknown;
          requests: Record<string, unknown>;
        };
        data = workspaceSchema.parse(parsed.data);
        requests = Object.fromEntries(
          Object.entries(parsed.requests).map(([id, doc]) => [
            id,
            requestSchema.parse(doc),
          ]),
        );
      }
    } catch {
      data = emptyWorkspace();
      requests = {};
    }
  }
  const save = () => {
    if (persist) localStorage.setItem(key, JSON.stringify({ data, requests }));
  };
  const uuid = () => crypto.randomUUID();
  const now = () => Date.now();
  function named(name: string) {
    if (!name.trim() || name.trim().length > 200)
      throw new DataError(
        "INVALID_INPUT",
        "Use a name between 1 and 200 characters.",
      );
    return name.trim();
  }
  function get(id: string) {
    const doc = requests[id];
    if (!doc)
      throw new DataError("NOT_FOUND", "This request no longer exists.");
    return doc;
  }
  function summaries() {
    data.requests = Object.values(requests).map(
      ({ id, collectionId, folderId, name, method, position, revision }) => ({
        id,
        collectionId,
        folderId,
        name,
        method,
        position,
        revision,
      }),
    );
  }
  function siblingPosition(collectionId: string, parentId: string | null) {
    return (
      Math.max(
        -1,
        ...data.folders
          .filter(
            (f) => f.collectionId === collectionId && f.parentId === parentId,
          )
          .map((f) => f.position),
        ...Object.values(requests)
          .filter(
            (r) => r.collectionId === collectionId && r.folderId === parentId,
          )
          .map((r) => r.position),
      ) + 1
    );
  }
  function parent(collectionId: string, parentId: string | null) {
    if (
      !data.collections.some((c) => c.id === collectionId) ||
      (parentId &&
        !data.folders.some(
          (f) => f.id === parentId && f.collectionId === collectionId,
        ))
    )
      throw new DataError(
        "INVALID_INPUT",
        "Invalid destination collection/folder.",
      );
  }
  function remove(item: TreeRef) {
    const folders = new Set(
      item.kind === "folder"
        ? [item.id]
        : item.kind === "collection"
          ? data.folders
              .filter((f) => f.collectionId === item.id)
              .map((f) => f.id)
          : [],
    );
    let again = true;
    while (again) {
      again = false;
      for (const folder of data.folders)
        if (
          folder.parentId &&
          folders.has(folder.parentId) &&
          !folders.has(folder.id)
        ) {
          folders.add(folder.id);
          again = true;
        }
    }
    data.folders = data.folders.filter((f) => !folders.has(f.id));
    if (item.kind === "collection")
      data.collections = data.collections.filter((c) => c.id !== item.id);
    if (item.kind === "collection") {
      data.environments = data.environments.filter(e => e.collectionId !== item.id);
      data.environmentSelections = data.environmentSelections.filter(s => s.collectionId !== item.id);
    }
    for (const doc of Object.values(requests))
      if (
        doc.id === item.id ||
        (item.kind === "collection" && doc.collectionId === item.id) ||
        (doc.folderId && folders.has(doc.folderId))
      )
        delete requests[doc.id];
    summaries();
    save();
  }
  return {
    async loadWorkspace() {
      summaries();
      data.session.tabIds = data.session.tabIds.filter((id) => requests[id]);
      if (data.session.activeId && !requests[data.session.activeId])
        data.session.activeId = null;
      return clone(data);
    },
    async createCollection(name) {
      const c = {
        id: uuid(),
        name: named(name),
        position: data.collections.length,
        createdAt: now(),
        updatedAt: now(),
      };
      data.collections.push(c);
      save();
      return clone(c);
    },
    async renameCollection(id, name) {
      const c = data.collections.find((c) => c.id === id);
      if (!c) throw new DataError("NOT_FOUND", "Collection not found.");
      c.name = named(name);
      c.updatedAt = now();
      save();
      return clone(c);
    },
    async deleteCollection(id) {
      remove({ kind: "collection", id });
    },
    async createFolder(input) {
      parent(input.collectionId, input.parentId);
      const f = {
        ...input,
        id: uuid(),
        name: named(input.name),
        position: siblingPosition(input.collectionId, input.parentId),
      };
      data.folders.push(f);
      save();
      return clone(f);
    },
    async updateFolder(input) {
      const f = data.folders.find((f) => f.id === input.id);
      if (!f) throw new DataError("NOT_FOUND", "Folder not found.");
      parent(f.collectionId, input.parentId);
      let cursor = input.parentId;
      while (cursor) {
        if (cursor === f.id)
          throw new DataError(
            "INVALID_INPUT",
            "A folder cannot be moved into itself or a descendant.",
          );
        cursor = data.folders.find((f) => f.id === cursor)?.parentId ?? null;
      }
      if (f.parentId !== input.parentId)
        f.position = siblingPosition(f.collectionId, input.parentId);
      f.name = named(input.name);
      f.parentId = input.parentId;
      save();
      return clone(f);
    },
    async deleteFolder(id) {
      remove({ kind: "folder", id });
    },
    async createRequest(input) {
      parent(input.collectionId, input.folderId);
      const doc: RequestDoc = {
        collectionId: input.collectionId,
        folderId: input.folderId,
        id: uuid(),
        name: named(input.name),
        method: "GET",
        url: "",
        bodyKind: "none",
        body: "",
        params: [],
        headers: [],
        formData: [],
        ...clone(input.content ?? {}),
        position: siblingPosition(input.collectionId, input.folderId),
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      requests[doc.id] = doc;
      summaries();
      try { save(); }
      catch (error) {
        delete requests[doc.id];
        summaries();
        throw error;
      }
      return clone(doc);
    },
    async getRequest(id) {
      return clone(get(id));
    },
    async saveRequest(input) {
      const old = get(input.id);
      if (old.revision !== input.revision)
        throw new DataError(
          "CONFLICT",
          "A newer saved version exists. Your draft was kept.",
        );
      parent(input.collectionId, input.folderId);
      const saved = {
        ...clone(input),
        name: named(input.name),
        revision: old.revision + 1,
        createdAt: old.createdAt,
        updatedAt: now(),
        position:
          old.folderId === input.folderId
            ? old.position
            : siblingPosition(input.collectionId, input.folderId),
      };
      requests[input.id] = saved;
      summaries();
      save();
      return clone(saved);
    },
    async deleteRequest(id) {
      remove({ kind: "request", id });
    },
    async reorderItems(input) {
      for (const [position, item] of input.items.entries()) {
        const node =
          item.kind === "collection"
            ? data.collections.find((c) => c.id === item.id)
            : item.kind === "folder"
              ? data.folders.find((f) => f.id === item.id)
              : requests[item.id];
        if (node) node.position = position;
      }
      summaries();
      save();
    },
    async saveEnvironment(input) {
      const name = named(input.name);
      validateEnvironment(input);
      if (input.collectionId) parent(input.collectionId, null);
      const existing = data.environments.find(e => e.id === input.id);
      if (input.id && !existing) throw new DataError("NOT_FOUND", "This environment no longer exists.");
      if (existing && (existing.revision !== input.revision || existing.collectionId !== input.collectionId))
        throw new DataError("CONFLICT", "This environment changed. Reset before retrying.");
      if (data.environments.some(e => e.id !== input.id && e.collectionId === input.collectionId && e.name === name))
        throw new DataError("INVALID_INPUT", "An environment with that name already exists in this scope.");
      const environment = { ...clone(input), id: input.id ?? uuid(), name, revision: (existing?.revision ?? 0) + 1 };
      const before = clone(data);
      try {
        data.environments = [...data.environments.filter(e => e.id !== environment.id), environment];
        save();
      } catch (error) { data = before; throw error; }
      return clone(environment);
    },
    async deleteEnvironment(id) {
      const before = clone(data);
      try {
        data.environments = data.environments.filter(e => e.id !== id);
        for (const s of data.environmentSelections) if (s.environmentId === id) s.environmentId = null;
        save();
      } catch (error) { data = before; throw error; }
    },
    async selectEnvironment(input) {
      if (input.collectionId) parent(input.collectionId, null);
      if (input.environmentId && !data.environments.some(e => e.id === input.environmentId && e.collectionId === input.collectionId))
        throw new DataError("INVALID_INPUT", "Select an environment from this scope.");
      const before = clone(data);
      try {
        data.environmentSelections = [...data.environmentSelections.filter(s => s.collectionId !== input.collectionId), clone(input)];
        save();
      } catch (error) { data = before; throw error; }
      return clone(input);
    },
    async saveSession(input) {
      data.session = clone(input);
      save();
      return clone(input);
    },
    async pickAttachment() {
      throw new DataError(
        "DESKTOP_REQUIRED",
        "File selection requires the native Tauri application. This is a browser fixture.",
      );
    },
  };
}
