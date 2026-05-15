// Mobile navigation. On narrow screens the desktop ModuleNav's
// horizontal link strip is unusable (links scroll out of view with
// no affordance). This renders a hamburger button + a full-width
// dropdown panel carrying every nav destination: dashboard, module
// links + their specialisations, configuration, theme, sign-out.
//
// The panel is portaled to document.body with fixed positioning —
// the header uses backdrop-blur, which traps position:fixed
// descendants, so an in-header panel would be clipped. Same trick
// the ModuleNav popover uses.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useNavigate } from "react-router-dom";
import { Menu, X, Moon, Sun, LogOut, Sliders } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { useNavModules } from "./useNavModules";

export function MobileNav() {
  const { activeSlug } = useActiveOrg();
  const { tops, childrenByParent } = useNavModules(activeSlug);
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Lock body scroll while the panel is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  function go(to: string) {
    navigate(to);
    setOpen(false);
  }

  const linkClass =
    "block px-4 py-3 text-sm border-b border-slate-100 dark:border-slate-800 " +
    "text-slate-700 dark:text-mortar-100 active:bg-mortar-50 dark:active:bg-slate-800 transition";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        className="md:hidden text-slate-500 dark:text-slate-400 hover:text-cobble-500 transition p-1.5"
      >
        {open ? <X size={20} /> : <Menu size={20} />}
      </button>

      {open &&
        createPortal(
          <div className="md:hidden fixed inset-0 z-[80]">
            {/* backdrop — tap to dismiss */}
            <div
              className="absolute inset-0 bg-slate-900/40"
              onClick={() => setOpen(false)}
            />
            {/* panel */}
            <nav
              className="absolute top-0 left-0 right-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 shadow-lg max-h-[88vh] overflow-y-auto"
              aria-label="Main navigation"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800">
                <span className="font-display font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
                  cobblr
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close menu"
                  className="text-slate-400 hover:text-cobble-500 transition p-1"
                >
                  <X size={18} />
                </button>
              </div>

              <NavLink to="/" end className={linkClass} onClick={() => setOpen(false)}>
                dashboard
              </NavLink>

              {tops.map((m) => {
                const kids = childrenByParent.get(m.name) ?? [];
                return (
                  <div key={m.name}>
                    <NavLink
                      to={`/${m.name}`}
                      className={linkClass}
                      onClick={() => setOpen(false)}
                    >
                      {m.displayName.toLowerCase()}
                    </NavLink>
                    {kids.map((k) => (
                      <button
                        key={k.name}
                        type="button"
                        onClick={() => go(`/${m.name}?lens=${k.name}`)}
                        className={
                          linkClass +
                          " w-full text-left pl-8 text-slate-500 dark:text-slate-400"
                        }
                      >
                        {k.displayName}
                        <span className="ml-2 text-[10px] font-mono text-slate-400">
                          lens
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })}

              <NavLink
                to="/configuration"
                className={linkClass + " flex items-center gap-2"}
                onClick={() => setOpen(false)}
              >
                <Sliders size={14} />
                configuration
              </NavLink>

              <button
                type="button"
                onClick={() => {
                  toggle();
                  setOpen(false);
                }}
                className={linkClass + " w-full text-left flex items-center gap-2"}
              >
                {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
                {theme === "dark" ? "switch to light" : "switch to dark"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  logout();
                }}
                className={
                  linkClass +
                  " w-full text-left flex items-center gap-2 text-ember-500 dark:text-ember-500"
                }
              >
                <LogOut size={14} />
                sign out
              </button>
            </nav>
          </div>,
          document.body,
        )}
    </>
  );
}
