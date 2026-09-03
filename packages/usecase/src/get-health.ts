import type { Health } from "@offdesk/domain";

export const getHealth = (): Health => ({ status: "ok" });
