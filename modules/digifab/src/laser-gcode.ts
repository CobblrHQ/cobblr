import { validateLaserPlan, type LaserMotionPlan } from "./laser-motion-plan.js";
export const GCODE_DIALECTS = {
 forgefirm:{on:"M4",airOn:"M8",airOff:"M9",status:"grbl",mode:"$32=1",scale:"$30",origin:"upper-left",end:"M2"},
 grbl:{on:"M4",airOn:"M8",airOff:"M9",status:"grbl",mode:"$32=1",scale:"$30"},
 "grbl-lpc":{on:"M4",airOn:"M8",airOff:"M9",status:"grbl",mode:"$32=1",scale:"$30"},
 grblhal:{on:"M4",airOn:"M8",airOff:"M9",status:"grbl",mode:"$32=1",scale:"$30"},
 fluidnc:{on:"M4",airOn:"M8",airOff:"M9",status:"grbl",mode:"laser spindle",scale:"spindle speed map"},
 smoothieware:{on:null,airOn:"M8",airOff:"M9",status:"smoothie",mode:"laser_module_enable=true",scale:"laser_module_maximum_s_value"},
 marlin:{on:"M3 I",off:"M5 I",airOn:"M8",airOff:"M9",status:"marlin",mode:"LASER_FEATURE and LASER_POWER_INLINE",scale:"CUTTER_POWER_UNIT"},
 snapmaker:{on:"M3",powerWord:"P",airOn:null,airOff:null,status:"marlin",mode:"laser toolhead",scale:"100"},
} as const;
export type GcodeController = {firmware:keyof typeof GCODE_DIALECTS;powerMax:number;powerMin:number;laserMode:boolean;homing:boolean;homed:boolean;inlinePower?:boolean;coolant?:boolean};
export function parseGrblSettings(text:string):Omit<GcodeController,"firmware"|"homed"> {
 const get=(n:number)=>{const match=new RegExp(`^\\$${n}=([0-9.]+)\\s*$`,"m").exec(text);if(!match)throw new Error("The controller did not report its laser and homing settings.");return Number(match[1]);};
 const mode=get(32),homing=get(22);if(![0,1].includes(mode)||![0,1].includes(homing))throw new Error("The controller reported invalid laser or homing settings.");
 return {powerMax:get(30),powerMin:get(31),laserMode:mode===1,homing:homing===1};
}
export function validateGcodeController(c:GcodeController):void {
 const d=GCODE_DIALECTS[c.firmware];if(!d)throw new Error("Choose a supported G-code firmware.");
 if(c.firmware==="smoothieware"&&c.powerMin!==0)throw new Error("Disable Smoothie laser keepalive power before Frame or Start.");
 if(c.firmware==="marlin"&&c.inlinePower!==true)throw new Error("Enable and report Marlin inline laser power before sending this job.");
 if(c.firmware==="snapmaker"&&(c.powerMax!==100||c.powerMin!==0))throw new Error("Snapmaker requires a percentage power scale of 0 to 100.");
 if(!c.laserMode)throw new Error(`Enable laser mode (${d.mode}) before sending this job.`);
 if(!Number.isFinite(c.powerMax)||!Number.isFinite(c.powerMin)||c.powerMax<=0||c.powerMin<0||c.powerMin>=c.powerMax)throw new Error("The controller's power scale is invalid.");
 if((c.homing||c.firmware==="forgefirm")&&!c.homed)throw new Error("Home the laser before Frame or Start. Its controller must report a homed position.");
}
const n=(v:number)=>String(Number(v.toFixed(5)));
const xy=(p:{x:number;y:number})=>`X${n(p.x)} Y${n(p.y)}`;
const offFor=(firmware:keyof typeof GCODE_DIALECTS)=>firmware==="marlin"?["M5 I"]:firmware==="snapmaker"?["M5"]:["M5","S0"];
const positionFor=(p:{x:number;y:number},plan:LaserMotionPlan,firmware:keyof typeof GCODE_DIALECTS)=>xy(firmware==="forgefirm"?{x:p.x,y:plan.bed.height-p.y}:p);
export function emitFrame(raw:LaserMotionPlan,firmware:keyof typeof GCODE_DIALECTS="grbl"):string {
 const p=validateLaserPlan(raw),b=p.bounds;
 const at=(point:{x:number;y:number})=>positionFor(point,p,firmware);
 return ["G21","G90",...offFor(firmware),`G0 ${at(b)}`,`G0 ${at({x:b.x+b.width,y:b.y})}`,`G0 ${at({x:b.x+b.width,y:b.y+b.height})}`,`G0 ${at({x:b.x,y:b.y+b.height})}`,`G0 ${at(b)}`,...offFor(firmware),...(firmware!=="marlin"&&GCODE_DIALECTS[firmware].airOff?[GCODE_DIALECTS[firmware].airOff]:[]),""] .join("\n");
}
export function emitGcode(raw:LaserMotionPlan,c:GcodeController):string {
 const p=validateLaserPlan(raw);validateGcodeController(c);
 const at=(point:{x:number;y:number})=>positionFor(point,p,c.firmware);
 const d=GCODE_DIALECTS[c.firmware],off=offFor(c.firmware),airOn=c.firmware==="marlin"&&!c.coolant?null:d.airOn,airOff=c.firmware==="marlin"&&!c.coolant?null:d.airOff,lines=["G21","G90",...(["marlin","snapmaker"].includes(c.firmware)?[]:["G94"]),...off,...(airOff?[airOff]:[])];
 for(const layer of p.layers) {
  if(layer.focus_offset!==0||layer.min_power!==0)throw new Error("This G-code profile needs zero focus offset and zero minimum power. Set focus at the machine; dynamic power uses the controller's own minimum.");
  if(layer.max_power<layer.min_power)throw new Error("The profile's maximum power must be at least its minimum.");
  const power=layer.max_power===0?0:c.powerMin+(c.powerMax-c.powerMin)*layer.max_power/100;
  if(layer.air_assist&&c.firmware==="marlin"&&!c.coolant)throw new Error("Marlin must report coolant control before using air assist.");
  if(layer.air_assist&&!airOn)throw new Error("This firmware cannot control air assist. Use a profile with manual air assist at the machine.");
  const air=layer.air_assist?airOn:airOff;if(air)lines.push(air);
  for(let pass=0;pass<layer.passes;pass++)for(const path of p.paths.filter(p=>p.layer_index===layer.index)) {
   lines.push(...off,`G0 ${at(path.points[0]!)}`);
   if(d.on)lines.push("powerWord" in d?`${d.on} ${d.powerWord}${n(power)}`:`${d.on} S0`);
   for(const point of path.points.slice(1))lines.push(`G1 ${at(point)} F${n(layer.speed*60)}${"powerWord" in d?"":` S${n(power)}`}`);
   lines.push(...off);
  }
 }
 lines.push(off[0]!);if(airOff)lines.push(airOff);
 if(p.layers.some(l=>l.return_to_origin))lines.push(...off,`G0 ${at({x:0,y:0})}`);
 if("end" in d)lines.push(d.end);
 return lines.join("\n")+"\n";
}
