export interface CncPoint { x: number; y: number; z: number }
export interface CncBounds { min: CncPoint; max: CncPoint }
export interface CncTool { number: number; diameter: number | null; description: string; estimatedSeconds: number }
export interface CncStep { code: string; tool: number; change?: number; pause?: boolean }
export interface CncProgram { version: 1; bounds: CncBounds; tools: CncTool[]; estimatedSeconds: number; steps: CncStep[] }
export interface CncMachine { envelope: CncBounds; safeZ: number; rapidFeed: number; reminders: string[] }
export interface CncStock { width: number; height: number; thickness: number }
export interface CncChecks { stockLoaded: boolean; probedZ: boolean; workOffset: boolean; clampsClear: boolean; reminders: string[]; tools: { number: number; diameter: number; loaded: boolean }[] }
const axes = ["x", "y", "z"] as const;
const finite = (v: number) => Number.isFinite(v);
const distance = (a:CncPoint,b:CncPoint) => Math.hypot(...axes.map(k => b[k]-a[k]));
const tau = 2*Math.PI;
const angle = (v:number) => (v%tau+tau)%tau;
const sweep = (from:number,to:number,cw:boolean) => angle(cw?from-to:to-from)||tau;

export function parseCncProgram(code: string, rapidFeed = 3000): CncProgram {
 if (code.length>5_000_000 || !code.trim() || !finite(rapidFeed) || rapidFeed<=0) throw new Error("Choose a posted CNC program smaller than 5 MB and a positive rapid feed.");
 const source=code.split(/\r?\n/); if(source.length>100_000) throw new Error("Split this program into files of at most 100000 lines.");
 const uncommented=source.map(line=>line.replace(/\([^()]*\)/g,"").replace(/;.*$/,""));
 const units=new Set(uncommented.flatMap(line=>[...line.matchAll(/G\s*(20|21)(?![\d.])/gi)].map(m=>m[1])));
 if(units.size!==1) throw new Error("Post this program in one explicit unit system, G20 or G21.");
 const scale=units.has("20")?25.4:1;
 const toolMap=new Map<number,CncTool>();
 const getTool=(number:number):CncTool=>{ if(!Number.isInteger(number)||number<1||number>9999) throw new Error("Use tool numbers from 1 to 9999."); let tool=toolMap.get(number);if(!tool){tool={number,diameter:null,description:`Tool ${number}`,estimatedSeconds:0};toolMap.set(number,tool);}return tool; };
 for(const line of source) {
  const comments=[...line.matchAll(/\(([^()]*)\)|;(.+)$/g)].map(m=>m[1]??m[2]??"");
  for(const text of comments) {
   const n=/\bT(?:ool\s*[:=#]?\s*T?)?\s*(\d+)\b/i.exec(text);
   if(!n)continue;
   const tool=getTool(Number(n[1])),d=/\b(?:DIAMETER|DIAM|DIA|D)(?:\s*[:=]\s*|\s+)([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*\/\s*\d+)?)\s*(mm|in(?:ch(?:es)?)?|\")?/i.exec(text);
   if(d) { const fraction=d[1]!.split("/").map(Number);const diameter=(fraction[0]!/(fraction[1]??1))*(d[2]?d[2].toLowerCase()==="mm"?1:25.4:scale);if(!finite(diameter)||diameter<=0) throw new Error("The posted tool diameter must be positive.");if(tool.diameter!==null&&Math.abs(tool.diameter-diameter)>0.001)throw new Error("A tool number has conflicting posted diameters.");tool.diameter=diameter; }
   const description=text.replace(/^.*?\bT(?:ool\s*[:=#]?\s*T?)?\s*\d+\b\s*/i,"").replace(/\b(?:DIAMETER|DIAM|DIA|D)(?:\s*[:=]\s*|\s+)[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*\/\s*\d+)?\s*(?:mm|in(?:ch(?:es)?)?|\")?/gi,"").replace(/\b(?:CR|ZMIN)\s*=\s*-?[\d.]+/gi,"").replace(/^[\s:,-]+|[\s:,-]+$/g,"");
   if(description)tool.description=description.slice(0,200);
  }
 }
 const bounds:CncBounds={min:{x:Infinity,y:Infinity,z:Infinity},max:{x:-Infinity,y:-Infinity,z:-Infinity}};
 const include=(p:CncPoint)=>{for(const k of axes){bounds.min[k]=Math.min(bounds.min[k],p[k]);bounds.max[k]=Math.max(bounds.max[k],p[k]);}};
 let position:CncPoint={x:0,y:0,z:0}, feed=0,motion=0,absolute=false,distanceMode=false,unitMode=false,planeMode=false,feedMode=false,motionMode=false,selected=0,active=0,ended=false,leadRequired=true;
 const steps:CncStep[]=[];
 const knownAxes=new Set<string>();
 for(let index=0;index<source.length;index++) {
  const raw=uncommented[index]!.trim().toUpperCase();if(!raw||raw==="%")continue;
  const fail=(why:string):never=>{throw new Error(`Line ${index+1}: ${why}`);};
  if(ended)fail("Remove executable lines after the end of the program.");
  const words=[...raw.matchAll(/([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g)];
  if(raw.replace(/([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g,"").trim())fail("Macros, expressions and block deletion cannot be reviewed. Post explicit moves.");
  const values:Record<string,number>={},gs:number[]=[],ms:number[]=[];
  for(const w of words){const key=w[1]!,v=Number(w[2]);if(!finite(v)||Math.abs(v)>1e8)fail("A word exceeds the supported numeric range.");if(key==="G")gs.push(v);else if(key==="M")ms.push(v);else {if(!"XYZIJKRFSTPN".includes(key))fail(`Unsupported word ${key}.`);if(key in values&&key!=="N")fail(`Repeated ${key} word.`);values[key]=v;}}
  for(const g of gs) {
   if(![0,1,2,3,4,17,20,21,40,49,54,80,90,91,91.1,94].includes(g))fail(`G${g} cannot be bounded. Post explicit three-axis moves in G54 without compensation or canned cycles.`);
   if(g<=3){motion=g;motionMode=true;}
   if(g===80)motionMode=false;
   if(g===20||g===21)unitMode=true;
   if(g===17)planeMode=true;
   if(g===94)feedMode=true;
   if(g===90){absolute=true;distanceMode=true;}
   if(g===91){absolute=false;distanceMode=true;}
  }
  for(const m of ms)if(![0,1,2,3,4,5,6,7,8,9,30].includes(m))fail(`Unsupported M${m}.`);
  if(values.T!==undefined)selected=getTool(values.T).number;
  if(values.F!==undefined){feed=values.F*scale;if(feed<=0)fail("Feed must be positive.");}
  const hasMove=axes.some(k=>values[k.toUpperCase()]!==undefined)||values.I!==undefined||values.J!==undefined||values.R!==undefined;
  if(ms.includes(6)) {
   if(!selected||hasMove||ms.length!==1||gs.length)fail("Put each Tn M6 on its own line before moving.");
   if(knownAxes.size && position.z<0)fail("Retract above the stock before a manual tool change.");
   knownAxes.clear();leadRequired=true;active=selected;steps.push({code:"",tool:active,change:active});continue;
  }
  if(ms.includes(0)||ms.includes(1)){if(hasMove||gs.length||ms.length!==1)fail("Put each manual pause on its own line.");steps.push({code:"",tool:active,pause:true});continue;}
  if(hasMove) {
   if(!unitMode||!distanceMode||!motionMode)fail("Declare units, G90 or G91, and a motion mode before motion.");
   if(leadRequired && (!absolute || motion!==0))fail("Set an absolute XYZ clearance position with G0 before cutting after a tool change.");
   if(!absolute&&knownAxes.size!==3)fail("Set an absolute XYZ position before incremental motion.");
   if(motion!==0&&!feedMode)fail("Declare G94 before cutting.");
   if((motion===2||motion===3)&&!planeMode)fail("Declare G17 before arcs.");
   if(!active)active=selected;
   if(!active)fail("Declare the tool number before motion.");
   const tool=getTool(active),next={...position};
   for(const k of axes)if(values[k.toUpperCase()]!==undefined){next[k]=(absolute?0:position[k])+values[k.toUpperCase()]!*scale;knownAxes.add(k);}
   if(leadRequired && next.z<0)fail("Establish an absolute XYZ clearance position above the stock before descending.");
   if(leadRequired && knownAxes.size===3 && next.z>=0)leadRequired=false;
   include(position);include(next);let length=distance(position,next);
   if(motion===2||motion===3) {
    if(values.K!==undefined)fail("Post arcs in the XY plane.");
    const cw=motion===2;
    let cx:number,cy:number;
    if(values.R!==undefined) {
     if(values.I!==undefined||values.J!==undefined)fail("Use either R or I/J for an arc.");
     const dx=next.x-position.x,dy=next.y-position.y,chord=Math.hypot(dx,dy),r=values.R*scale;
     if(!chord||chord>2*Math.abs(r)+1e-6)fail("The arc radius does not match its endpoints.");
     const h=Math.sqrt(Math.max(0,r*r-chord*chord)),side=(cw?-1:1)*(r<0?-1:1);
     cx=(position.x+next.x)/2-side*dy/chord*h;cy=(position.y+next.y)/2+side*dx/chord*h;
    } else {
     if(values.I===undefined&&values.J===undefined)fail("An arc needs an explicit centre or radius.");
     cx=position.x+(values.I??0)*scale;cy=position.y+(values.J??0)*scale;
    }
    const radius=Math.hypot(position.x-cx,position.y-cy),other=Math.hypot(next.x-cx,next.y-cy);
    if(!radius||Math.abs(radius-other)>Math.max(0.005,radius*0.0001))fail("The arc endpoints do not share a radius.");
    const start=Math.atan2(position.y-cy,position.x-cx),end=Math.atan2(next.y-cy,next.x-cx),extent=sweep(start,end,cw);
    for(const a of [0,Math.PI/2,Math.PI,3*Math.PI/2])if(angle(cw?start-a:a-start)<=extent+1e-9)include({x:cx+radius*Math.cos(a),y:cy+radius*Math.sin(a),z:position.z});
    length=Math.hypot(radius*extent,next.z-position.z);
   } else if(values.I!==undefined||values.J!==undefined||values.K!==undefined||values.R!==undefined)fail("Arc words require G2 or G3.");
   if(gs.includes(4))fail("Put dwell on its own line.");
   if(motion!==0&&feed<=0)fail("Declare a feed before cutting.");
   tool.estimatedSeconds+=length/(motion===0?rapidFeed:feed)*60;position=next;
  }
  if(gs.includes(4)){if(values.P===undefined||values.P<0)fail("Dwell needs a nonnegative P in seconds.");if(active)getTool(active).estimatedSeconds+=values.P!;}
  if(ms.includes(2)||ms.includes(30))ended=true;
  const wire=words.filter(w=>w[1]!=="N"&&w[1]!=="T").map(w=>`${w[1]}${w[1]==="G"||w[1]==="M"?Number(w[2]):w[2]!.replace(/^\+/,"").replace(/^(-?)\./,(_match,sign:string)=>`${sign}0.`)}`).join(" ");
  if(wire)steps.push({code:wire,tool:active});
 }
 if(!axes.every(k=>finite(bounds.min[k])&&finite(bounds.max[k]))||!active)throw new Error("This posted program contains no bounded tool motion.");
 if([...toolMap.values()].some(t=>!finite(t.estimatedSeconds)))throw new Error("The posted feed produces an invalid runtime estimate.");
 const tools=[...toolMap.values()].filter(t=>steps.some(s=>s.tool===t.number));
 return {version:1,bounds,tools,estimatedSeconds:tools.reduce((sum,t)=>sum+t.estimatedSeconds,0),steps};
}

export function validateCncMachineBounds(program:CncProgram,machine:CncMachine):void {
 if(!machine||!machine.envelope||!finite(machine.safeZ)||!finite(machine.rapidFeed)||machine.rapidFeed<=0||!Array.isArray(machine.reminders))throw new Error("Save the CNC envelope, safe Z, rapid feed and reminders first.");
 for(const k of axes){const low=machine.envelope.min[k],high=machine.envelope.max[k];if(!finite(low)||!finite(high)||low>=high||program.bounds.min[k]<low-1e-6||program.bounds.max[k]>high+1e-6)throw new Error("The program bounds exceed the machine envelope in the confirmed work coordinates.");}
 if(machine.safeZ<=Math.max(0,program.bounds.max.z)||machine.safeZ>machine.envelope.max.z)throw new Error("Choose a safe Z above the stock and all program moves, inside the machine envelope.");
}

export function validateCncPreflight(program: CncProgram, machine: CncMachine, stock: CncStock, checks: CncChecks): void {
 validateCncMachineBounds(program,machine);
 if(![stock.width,stock.height,stock.thickness].every(v=>finite(v)&&v>0)||program.bounds.min.x< -1e-6||program.bounds.min.y< -1e-6||program.bounds.max.x>stock.width+1e-6||program.bounds.max.y>stock.height+1e-6||program.bounds.min.z< -stock.thickness-1e-6)throw new Error("The program bounds exceed the loaded stock. Use stock-top Z zero.");
 for(const tool of program.tools){const loaded=checks.tools.filter(t=>t.number===tool.number);if(loaded.length!==1||!loaded[0]!.loaded||!finite(loaded[0]!.diameter)||loaded[0]!.diameter<=0||(tool.diameter!==null&&Math.abs(loaded[0]!.diameter-tool.diameter)>0.01))throw new Error(`Load tool ${tool.number}: ${tool.description}. Its library diameter must match the posted program.`);}
 if(!checks.stockLoaded||!checks.probedZ||!checks.workOffset||!checks.clampsClear||machine.reminders.some(item=>!checks.reminders.includes(item)))throw new Error("Confirm probed Z, the work offset, clear clamps and each machine reminder before Start.");
}

export function cncFrame(program: CncProgram, safeZ: number): string {
 if(!finite(safeZ)||safeZ<=Math.max(0,program.bounds.max.z))throw new Error("Frame requires a safe Z above the program.");
 const n=(v:number)=>String(Number(v.toFixed(6))),b=program.bounds;
 return ["G21 G90 G17 G94 G54","M5","M9",`G0 Z${n(safeZ)}`,`G0 X${n(b.min.x)} Y${n(b.min.y)}`,`G0 X${n(b.max.x)} Y${n(b.min.y)}`,`G0 X${n(b.max.x)} Y${n(b.max.y)}`,`G0 X${n(b.min.x)} Y${n(b.max.y)}`,`G0 X${n(b.min.x)} Y${n(b.min.y)}`].join("\n")+"\n";
}
