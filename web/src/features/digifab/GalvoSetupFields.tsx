import {useEffect,useState,type MutableRefObject} from "react";
import {useMutation} from "@tanstack/react-query";
import {GalvoSettingsSchema,type LaserCommission,type LaserSetup,type GalvoSettings} from "@cobblr/platform-contract/laser-setup";
const input="block min-h-12 w-full rounded border border-line bg-surface p-2";
type SettingKey=Exclude<keyof GalvoSettings,"fpkParameters"|"standby">|"fpk0"|"fpk1"|"fpk2"|"fpk3";
const groups:Array<{name:string;fields:Array<[SettingKey,string]>}>=[
 {name:"Lens field and motion",fields:[["fieldWidthMm","Lens field width (mm)"],["fieldHeightMm","Lens field height (mm)"],["travelSpeedMmSec","Travel speed (mm/s)"],["frameSpeedMmSec","Guide speed (mm/s)"]]},
 {name:"Source and outputs",fields:[["frequencyKhz","Frequency (kHz)"],["guidePort","Red guide output bit"],["enablePort","Source enable output bit"]]},
 {name:"Red guide alignment",fields:[["guideOffsetXmm","Guide X offset (mm)"],["guideOffsetYmm","Guide Y offset (mm)"],["guideScaleX","Guide X scale"],["guideScaleY","Guide Y scale"]]},
 {name:"Manufacturer source and timing settings",fields:[["laserOnDelayUs","Laser on delay (µs)"],["laserOffDelayUs","Laser off delay (µs)"],["jumpDelayUs","Jump delay (µs)"],["polygonDelayUs","Polygon delay (µs)"],["moOnDelayUs","Source warm-up delay (µs)"],["controlMode","Control mode"],["laserMode","Laser mode"],["delayMode","Delay mode"],["timingMode","Timing mode"],["pwmHalfPeriod","PWM half period"],["pwmPulseWidth","PWM pulse width"],["firstPulseKiller","First pulse killer"],["fpk0","First pulse parameter 1"],["fpk1","First pulse parameter 2"],["fpk2","First pulse parameter 3"],["fpk3","First pulse parameter 4"],["analogPort1","Analog output 1"]]},
];
export interface GalvoSetupMemory{draft:Record<string,string>;correction:{name:string;base64:string}|null}
type Commission=Extract<LaserCommission,{firmware:"galvo"}>;
export function GalvoSetupFields({report,disabled,reset,onConfirm,memory}:{memory?:MutableRefObject<GalvoSetupMemory>;report:LaserSetup|null;disabled:boolean;reset:number;onConfirm:(configuration:Commission)=>void}){
 const [draft,setDraft]=useState<Record<string,string>>(memory?.current.draft||{}),[correction,setCorrection]=useState<{name:string;base64:string}|null>(memory?.current.correction||null),[fileError,setFileError]=useState("");
 const [lens,setLens]=useState(false),[source,setSource]=useState(false),[guide,setGuide]=useState(false);
 const readFile=useMutation({mutationKey:["galvo-lens-read"],mutationFn:(selected:File)=>new Promise<string>((resolve,reject)=>{
  const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]||"");reader.onerror=()=>reject(new Error("The lens file could not be read."));reader.readAsDataURL(selected);
 }),onError:error=>setFileError(error.message)});
 const reading=readFile.isPending;
 useEffect(()=>{if(memory)memory.current={draft,correction};},[draft,correction,memory]);
 useEffect(()=>{setLens(false);setSource(false);setGuide(false);},[reset]);
 const values:Record<string,unknown>={};
 for(const group of groups)for(const [key]of group.fields)values[key]=draft[key]?.trim()?Number(draft[key]):undefined;
 for(const key of ["flipX","flipY","swapXY","powerInverted"])values[key]=draft[key]==="true"?true:draft[key]==="false"?false:undefined;
 values.source=draft.source;values.frequencyClockKhz=draft.frequencyClockKhz?Number(draft.frequencyClockKhz):undefined;
 for(const key of ["airPort","pulseWidthNs"])values[key]=draft[key]==="none"?null:draft[key]?.trim()?Number(draft[key]):undefined;
 values.fpkParameters=[values.fpk0,values.fpk1,values.fpk2,values.fpk3];for(let i=0;i<4;i++)delete values[`fpk${i}`];values.standby=[0,0];
 const parsed=GalvoSettingsSchema.safeParse(values);
 const set=(key:string,value:string)=>{setDraft(old=>({...old,[key]:value}));setLens(false);setSource(false);setGuide(false);};
 const select=(key:string,label:string,choices:Array<[string,string]>)=><label className="block" key={key}>{label}<select className={input} value={draft[key]||""} disabled={disabled||reading} onChange={e=>set(key,e.target.value)}><option value="">Check the machine settings</option>{choices.map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label>;
 const file=(selected:File|undefined)=>{
  setCorrection(null);setFileError("");setLens(false);
  if(!selected)return;
  if(![68112,33836].includes(selected.size)){setFileError("Choose a complete manufacturer COR file for this lens.");return;}
  readFile.mutate(selected,{onSuccess:base64=>setCorrection({name:selected.name,base64})});
 };
 if(report?.firmware!=="galvo"||report.commissioned)return null;
 return <div className="space-y-4">
  <p>Use this machine's manufacturer settings and lens correction file. Check the field size, source, timing and red guide before confirming. Standby power stays off. Set focus and any manual air assist at the machine.</p>
  <label className="block">Lens correction file<input type="file" accept=".cor" className={input} disabled={disabled||reading} onChange={e=>file(e.target.files?.[0])} /></label>
  {correction&&<p className="text-sm break-words">Lens file: {correction.name}</p>}{fileError&&<p role="alert">{fileError}</p>}
  {select("source","Laser source",[["fiber","Fiber"],["co2","CO₂"],["uv","UV"]])}
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{select("frequencyClockKhz","Source frequency clock",[["20000","20 MHz, fiber Q-switch"],["10000","10 MHz, CO₂; check UV settings"]])}{select("powerInverted","UV power inversion",[["false","No inversion"],["true","Inverted UV power"]])}</div>
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label>Pulse width (ns), or none<input className={input} value={draft.pulseWidthNs||""} disabled={disabled||reading} onChange={e=>set("pulseWidthNs",e.target.value)} /></label><label>Air output bit, or none<input className={input} value={draft.airPort||""} disabled={disabled||reading} onChange={e=>set("airPort",e.target.value)} /></label></div>
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{select("flipX","Mirror X",[["false","No"],["true","Yes"]])}{select("flipY","Mirror Y",[["false","No"],["true","Yes"]])}{select("swapXY","Swap X and Y",[["false","No"],["true","Yes"]])}</div>
  {groups.map(group=><fieldset key={group.name} className="rounded border border-line p-3 space-y-3"><legend className="px-1 font-medium">{group.name}</legend><div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{group.fields.map(([key,label])=><label key={key}>{label}<input type="number" step="any" className={input} disabled={disabled||reading} value={draft[key]||""} onChange={e=>set(key,e.target.value===""?"":String(e.target.valueAsNumber))} /></label>)}</div></fieldset>)}
  {!parsed.success&&<p className="text-sm text-muted">Complete all settings from the manufacturer. {Object.keys(draft).length>0?parsed.error.issues[0]?.message:""}</p>}
  {parsed.success&&<p>Check: {parsed.data.source}, {parsed.data.fieldWidthMm} × {parsed.data.fieldHeightMm} mm, {parsed.data.frequencyKhz} kHz. Guide bit {parsed.data.guidePort}, source bit {parsed.data.enablePort}, air {parsed.data.airPort===null?"manual":`bit ${parsed.data.airPort}`}.</p>}
  <label className="flex items-start gap-3 min-h-12"><input type="checkbox" className="mt-1" checked={lens} disabled={disabled||reading} onChange={e=>setLens(e.target.checked)} /><span>This COR file and field size match the installed lens.</span></label>
  <label className="flex items-start gap-3 min-h-12"><input type="checkbox" className="mt-1" checked={source} disabled={disabled||reading} onChange={e=>setSource(e.target.checked)} /><span>I checked the source and timing against the manufacturer settings, and set focus and manual air assist at the machine.</span></label>
  <label className="flex items-start gap-3 min-h-12"><input type="checkbox" className="mt-1" checked={guide} disabled={disabled||reading} onChange={e=>setGuide(e.target.checked)} /><span>I checked the red guide alignment and its separate output. It cannot enable the marking source.</span></label>
  <button className="min-h-12 rounded border border-line px-4 py-3 disabled:opacity-50" disabled={disabled||reading||!parsed.success||!correction||!lens||!source||!guide} onClick={()=>{if(parsed.success&&correction)onConfirm({sessionId:report.sessionId,identityHash:report.identityHash,settingsHash:report.settingsHash,firmware:"galvo",settings:parsed.data,correctionBase64:correction.base64,lensConfirmed:true,sourceConfirmed:true,guideConfirmed:true});}}>Confirm galvo setup</button>
 </div>;
}
