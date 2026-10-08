import { useState } from "react";
import type { CncStationStock } from "@cobblr/platform-contract/cnc";
import { ScanOneSheet } from "../../components/ScanOneSheet";
import { resolveScannedThing,useScanTarget,type ScannedThing } from "../../lib/scanTarget";
export function CncStockScan({slug,stock,onPick}:{slug:string;stock:CncStationStock[];onPick:(id:string)=>void}) {
 const [scanning,setScanning]=useState(false),[error,setError]=useState("");
 const take=async(thing:ScannedThing)=>{const item=stock.find(item=>item.id===thing.id&&item.shape!=="wearing_tool");if(!item)throw new Error("That label does not name an available CNC sheet or block here.");onPick(item.id);setError("");return `Selected ${item.name}. Confirm it is loaded and check its work offset.`;};
 useScanTarget({takes:kind=>kind==="inventory:part"||kind.endsWith(":item"),take});
 return <><button className="min-h-12 rounded border border-line px-4 py-3" onClick={()=>{setError("");setScanning(true);}}>Scan loaded stock QR</button>{error&&<p role="alert">{error}</p>}{scanning&&<ScanOneSheet open title="Scan loaded stock QR" hint="Scan the sheet or block beside this machine." onClose={()=>setScanning(false)} onCode={code=>{setScanning(false);void(async()=>{try{const thing=await resolveScannedThing(slug,code);if(!thing)throw new Error("That label does not name stock in this workspace.");await take(thing);}catch(e){setError(e instanceof Error?e.message:String(e));}})();}}/>}</>;
}
