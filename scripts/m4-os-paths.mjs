import { resolve } from "node:path";
export const retest = process.env.POSTMEN_OS_QA_RETEST === "1";
// Fixed names only: never allow a user/profile/legacy database path as evidence.
export const destination = resolve(`docs/milestones/M4/${retest ? "os-input-fixed" : "os-input"}`);
