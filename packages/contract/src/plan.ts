import { z } from "zod";

export const PlanRemoveInput = z.object({
  planId: z
    .string()
    .regex(/^[0-9a-f]{32}$/, "planId は 32 桁の小文字 16 進です"),
});

export const PlanRemoveOutput = z.object({
  removed: z.boolean(),
});
