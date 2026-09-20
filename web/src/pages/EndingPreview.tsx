// A door to LOOK at the sandbox's ending without waiting an hour: the copy is
// the product there (#3254, the owner: "make the UI explain it correctly and
// then I'll criticize it live"). Renders only where /healthz says test_doors,
// the same gate as the scanner's image door; on a real deployment it goes
// home. The keep door on the preview talks to the real api, so on a box that
// hands out no sandboxes it says it could not keep; the words are what this
// route is for.
//
//   /try/ended                          the sandbox's hour, held 24 h
//   /try/ended?kind=trial               a kept trial whose time is up
//   /try/ended?hold=0                   the hold at zero (the old ending)
//   /try/ended?carry=1                  with the third door lit
import { Navigate, useSearchParams } from "react-router-dom";
import { useDeployEnv } from "../lib/deploy-env";
import { SandboxEnded } from "./SandboxEnded";

export function EndingPreview() {
  const { testDoors, ready } = useDeployEnv();
  const [params] = useSearchParams();
  // No verdict until the box has answered: the flag reads false while the
  // answer is on its way, and a redirect on that lands on the login screen.
  if (!ready) return null;
  if (!testDoors) return <Navigate to="/" replace />;
  const kind = params.get("kind") === "trial" ? "trial" : "sandbox";
  const hold = Number(params.get("hold") ?? "24");
  return (
    <SandboxEnded
      kind={kind}
      slug="preview"
      preview={{
        cloud_url: params.get("cloud") ?? "https://app.cobblr.xyz/signup",
        selfhost_url: "https://github.com/CobblrHQ/cobblr",
        decision_hours: Number.isFinite(hold) ? hold : 24,
        carry_available: params.get("carry") === "1",
      }}
    />
  );
}
