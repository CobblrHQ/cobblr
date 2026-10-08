import { CncMachineSchema } from "@cobblr/platform-contract/cnc";
export const cncEnvelopeFields = [
 {key:"minX",label:"Minimum work X (mm)"},{key:"minY",label:"Minimum work Y (mm)"},{key:"minZ",label:"Minimum work Z (mm)"},
 {key:"maxX",label:"Maximum work X (mm)"},{key:"maxY",label:"Maximum work Y (mm)"},{key:"maxZ",label:"Maximum work Z (mm)"},
 {key:"safeZ",label:"Safe Z above stock and moves (mm)"},{key:"rapidFeed",label:"Rapid feed estimate (mm/min)",optional:true},
 {key:"reminders",label:"Reminders, comma separated (none to skip)",optional:true,placeholder:"Spindle ready, Dust collector running"},
];
export function cncBridgeConfig(fields:Record<string,string>):Record<string,unknown> {
 const min={x:Number(fields.minX),y:Number(fields.minY),z:Number(fields.minZ)},max={x:Number(fields.maxX),y:Number(fields.maxY),z:Number(fields.maxZ)};
 const reminders=(fields.reminders||"Spindle ready, Dust collector running").trim().toLowerCase()==="none"?[]:(fields.reminders||"Spindle ready, Dust collector running").split(",").map(v=>v.trim()).filter(Boolean);
 const machine=CncMachineSchema.parse({envelope:{min,max},safeZ:Number(fields.safeZ),rapidFeed:Number(fields.rapidFeed||3000),reminders});
 if(!(["x","y","z"] as const).every(axis=>min[axis]<max[axis])||machine.safeZ>max.z)throw new Error("The safe Z and work envelope must fit this machine.");
 const axes:Record<string,number[]>={};
 for(const [key,maxIndex] of [["joints",8],["motors",3]] as const) if(fields[key]) {
  const values=fields[key]!.split(",").map(v=>/^\d+$/.test(v.trim())?Number(v.trim()):NaN);
  if(!values.length||values.length>maxIndex+1||new Set(values).size!==values.length||values.some(v=>!Number.isInteger(v)||v<0||v>maxIndex))throw new Error(`Enter every ${key==="joints"?"joint":"motor"} number once, from 0 to ${maxIndex}.`);
  axes[key]=values;
 }
 const omit=new Set(cncEnvelopeFields.map(f=>f.key));
 return {...Object.fromEntries(Object.entries(fields).filter(([key])=>!omit.has(key))),...axes,...machine};
}
