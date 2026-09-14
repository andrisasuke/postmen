import type { HttpMethod, KeyValueRow } from "../types/shell";
export interface ReferenceRequest {
  id: string;
  name: string;
  folder: "Users" | "Assets" | "";
  method: HttpMethod;
  url: string;
  body: string;
  params: KeyValueRow[];
  headers: KeyValueRow[];
}
export const collectionName = "PostMen Reference";
export const requests: ReferenceRequest[] = [
  {
    id: "list-users",
    name: "List users",
    folder: "Users",
    method: "GET",
    url: "http://127.0.0.1:43119/users?limit=10&active=true",
    body: "",
    params: [
      {
        id: "limit",
        enabled: true,
        name: "limit",
        value: "10",
        description: "",
      },
      {
        id: "active",
        enabled: true,
        name: "active",
        value: "true",
        description: "",
      },
    ],
    headers: [
      {
        id: "accept",
        enabled: true,
        name: "Accept",
        value: "application/json",
        description: "",
      },
      {
        id: "workspace",
        enabled: true,
        name: "X-Workspace",
        value: "PostMen",
        description: "",
      },
    ],
  },
  {
    id: "create-user",
    name: "Create user",
    folder: "Users",
    method: "POST",
    url: "http://127.0.0.1:43119/users",
    body: '{\n  "name": "Alex Morgan",\n  "email": "alex@example.com",\n  "active": true\n}',
    params: [],
    headers: [
      {
        id: "content-type",
        enabled: true,
        name: "Content-Type",
        value: "application/json",
        description: "",
      },
    ],
  },
  {
    id: "upload-asset",
    name: "Upload asset",
    folder: "Assets",
    method: "POST",
    url: "http://127.0.0.1:43119/upload",
    body: "",
    params: [],
    headers: [],
  },
  {
    id: "slow",
    name: "Slow response",
    folder: "",
    method: "GET",
    url: "http://127.0.0.1:43119/slow",
    body: "",
    params: [],
    headers: [],
  },
  {
    id: "error",
    name: "Server error",
    folder: "",
    method: "GET",
    url: "http://127.0.0.1:43119/error",
    body: "",
    params: [],
    headers: [],
  },
];
export const responseBody =
  '{\n  "success": true,\n  "data": {\n    "id": 42,\n    "name": "Alex Morgan",\n    "email": "alex@example.com",\n    "active": true\n  }\n}';
