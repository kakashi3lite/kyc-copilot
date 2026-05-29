import { Hono } from "hono";
import { getUsageSummary } from "../../services/billing/usage-meter.js";
import { getAuth } from "../middleware/auth.js";

export const usageRoutes = new Hono();

usageRoutes.get("/usage", async (c) => {
  const auth = getAuth(c);
  const summary = await getUsageSummary(auth.tenantId);
  return c.json({ ...summary, sixMonthHistory: [summary] });
});
