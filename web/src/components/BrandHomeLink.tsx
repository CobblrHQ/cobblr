import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BRAND_HOME } from "./shell-names";

/**
 * The brand link in both header layouts. Its name is where it goes, not what
 * the logo looks like (#8287), and the shell walk finds it by that name (#8510).
 */
export function BrandHomeLink({ className, children }: { className: string; children: ReactNode }) {
  return (
    <Link to="/" title={BRAND_HOME} aria-label={BRAND_HOME} className={className}>
      {children}
    </Link>
  );
}
