import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { ORDER_INTAKE } from "@cobblr/platform-contract/order-intake";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { IntakeConfig, configureIntake, intakeRound, readIntake } from "../intake.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const intakeRouter = Router({ mergeParams: true });
intakeRouter.get("/", asyncHandler(async (req, res) => {
  const connections = (await platform().services.connectionsFor(tenantContext(req).org.id, ORDER_INTAKE)).filter((c) => c.shared);
  res.json({ setting: await readIntake(tenantDb(req), instanceOf(req)), connections: connections.map((c) => ({ id: c.credentialId, label: c.label })) });
}));
// AI-REACH: exempt — a workspace administrator opts in to automatic order intake
intakeRouter.put("/", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const body = IntakeConfig.safeParse(req.body);
  if (!body.success) return badBody(res, body.error);
  const user = sessionUser(req);
  if (!user) { res.status(401).json({ error: { code: "session_required", message: "Sign in to configure intake." } }); return; }
  try {
    const setting = await configureIntake(tenantDb(req), tenantContext(req).org.id, instanceOf(req), user.id, body.data);
    res.json(setting);
  } catch (e) { res.status(400).json({ error: { code: "intake_configuration", message: e instanceof Error ? e.message : "Intake could not be configured." } }); }
}));
// AI-REACH: exempt — the administrator checks a configured source or retries its failed page
intakeRouter.post("/check", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  res.json(await intakeRound(tenantDb(req), tenantContext(req).org.id, instanceOf(req), true));
}));
