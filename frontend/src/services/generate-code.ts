import { z } from "zod";
import { call } from "./data";
import type { RequestDoc } from "../types/data";

export const curlCodeSchema = z.object({ code: z.string().min(1) });
export function generateCurl(request: RequestDoc) {
  return call("generate_curl", { input: { request } }, curlCodeSchema);
}
