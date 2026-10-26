/** Where `vite` and `vite preview` send /api: VITE_API_PROXY, else the compose
 *  stack's api. A bare host:port (as LOCAL_DEV.md wrote it) gets http://; the
 *  proxy took "ci-runners:4100" as a path, refused every call, and the app
 *  said sign-in was having trouble. Empty counts as unset (`||`): a caller
 *  passing "" through an env got a proxy with no target. */
export function apiProxyTarget(value: string | undefined): string {
  const target = value || "http://api:4000";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`;
}
