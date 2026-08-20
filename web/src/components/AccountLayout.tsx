// The ONE column every /me page wears.
//
// It is applied by the layout and not by the page for the same reason
// ConfigPageHeader draws the header: a decision re-made per page is a decision
// that drifts. Before this, nine /me pages carried five different widths and
// three centring behaviours (see lib/account-nav.ts).

import { Outlet, useLocation } from "react-router-dom";
import { accountColumnFor } from "../lib/account-nav";

export function AccountLayout() {
  const { pathname } = useLocation();
  return (
    <div className={accountColumnFor(pathname)}>
      <Outlet />
    </div>
  );
}
