// DEV-only pinned reference dataset; real WorkspaceApp components, simulated I/O.
import { createMemoryApi } from "./memory-api";
import { createExecutionFixture } from "./execution-api";
import { newRow, type RequestDoc } from "../types/data";
import type { ExecutionApi } from "../types/execution";

export async function createVisualFixture(empty = false) {
  const data = createMemoryApi();
  const execution = createExecutionFixture();
  const response: ExecutionApi = {
    ...execution,
    async execute(id) {
      const result = await execution.execute(id);
      if (result.outcome !== "success") return result;
      const body = JSON.stringify(
        {
          success: result.status !== 500,
          data: {
            id: 42,
            name: "Alex Morgan",
            email: "alex@example.com",
            active: true,
          },
        },
        null,
        2,
      );
      return {
        ...result,
        body,
        durationMs: 3,
        previewBytes: new TextEncoder().encode(body).length,
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "x-reference", value: "PostMen M0" },
          { name: "cache-control", value: "no-store" },
          { name: "date", value: "Sat, 05 Sep 2026 00:00:00 GMT" },
          { name: "connection", value: "keep-alive" },
          { name: "keep-alive", value: "timeout=5" },
          { name: "transfer-encoding", value: "chunked" },
        ],
      };
    },
  };
  if (!empty) {
    const collection = await data.createCollection("PostMen Reference");
    const assets = await data.createFolder({
      collectionId: collection.id,
      parentId: null,
      name: "Assets",
    });
    const users = await data.createFolder({
      collectionId: collection.id,
      parentId: null,
      name: "Users",
    });
    const row = (name: string, value: string) => ({ ...newRow(), name, value });
    const add = async (
      name: string,
      path: string,
      patch: Partial<RequestDoc> = {},
      folderId: string | null = null,
    ) => {
      const doc = await data.createRequest({
        collectionId: collection.id,
        folderId,
        name,
      });
      return data.saveRequest({
        ...doc,
        url: `http://127.0.0.1:43119${path}`,
        ...patch,
      });
    };
    await add(
      "List users",
      "/users?limit=10&active=true",
      {
        params: [row("limit", "10"), row("active", "true")],
        headers: [
          row("Accept", "application/json"),
          row("X-Workspace", "PostMen"),
        ],
      },
      users.id,
    );
    await add(
      "Create user",
      "/users",
      {
        method: "POST",
        bodyKind: "json",
        body: JSON.stringify(
          { name: "Alex Morgan", email: "alex@example.com", active: true },
          null,
          2,
        ),
        headers: [row("Content-Type", "application/json")],
      },
      users.id,
    );
    await add("Slow response", "/slow");
    await add("Server error", "/error");
    await add(
      "Upload asset",
      "/upload",
      {
        method: "POST",
        bodyKind: "multipart",
        formData: [
          {
            ...row("description", "Profile picture"),
            kind: "text",
            attachmentId: null,
          },
        ],
      },
      assets.id,
    );
  }
  return { data, execution: response };
}
