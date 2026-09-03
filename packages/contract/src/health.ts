import { z } from "zod";

export const HealthOutput = z.object({
  status: z.literal("ok"),
});
