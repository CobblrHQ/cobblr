// Keeps a station's screen on while it works: a wake lock, taken again when the
// tab comes back. Its own file, with no imports, because the app-wide browser
// laser provider needs it on every page and must not bring the station's scan
// rules into the first load (budget:first-load).
export function keepStationScreenAwake(document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">, wakeLock: Navigator["wakeLock"] | undefined): () => void {
 let stopped=false;
 let requesting=false;
 let lock:WakeLockSentinel|undefined;
 const acquire=async()=>{
  if(stopped||requesting||document.visibilityState!=="visible"||!wakeLock||(lock&&!lock.released))return;
  requesting=true;
  try{const next=await wakeLock.request("screen");if(stopped)await next.release();else lock=next;}catch{}finally{requesting=false;}
 };
 void acquire();document.addEventListener("visibilitychange",acquire);
 return()=>{stopped=true;document.removeEventListener("visibilitychange",acquire);void lock?.release();};
}
