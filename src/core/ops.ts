import { activityOps } from "./activity";
import { importOps } from "./import";
import { issueOps } from "./issues";
import { prOps } from "./prs";
import type { OpDef } from "./registry";
import { workflowOps } from "./workflow";
import { workspaceOps } from "./workspace";

export const OPS: Map<string, OpDef> = new Map([...issueOps, ...workspaceOps, ...workflowOps, ...prOps, ...importOps, ...activityOps].map((o) => [o.name, o]));
