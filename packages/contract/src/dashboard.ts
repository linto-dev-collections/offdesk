import { z } from "zod";
import { RunSummary } from "./run.ts";

export const PendingAsk = z.object({
  askId: z.string(),
  runKey: z.string(),
  projectName: z.string(),
  question: z.string(),
  optionCount: z.number().int(),
  postedToDiscord: z.boolean(),
  threadUrl: z.string().nullable(),
  createdAt: z.number().int(),
});
export type PendingAsk = z.infer<typeof PendingAsk>;

export const DashboardOutput = z.object({
  liveRuns: z.array(RunSummary),
  pendingAsks: z.array(PendingAsk),
  recentFailures: z.array(RunSummary),
});
export type DashboardOutput = z.infer<typeof DashboardOutput>;
