import {z} from "zod";
const configKeys=new Set(["host","port","transport","path","baud","firmware","magic","usbSerial","boardId","serial"]);
const text=(max:number)=>z.string().max(max).refine(value=>!/[\x00-\x1f]/.test(value));
export const FoundBridgeDevice=z.object({
 kind:text(80).optional(),model:text(120).optional(),serial:text(120).optional(),
 id:text(160),name:text(120),address:text(512),transport:z.enum(["usb","lan"]),driver:text(80).nullable(),
 config:z.record(text(80),text(512)).refine(value=>Object.keys(value).every(key=>configKeys.has(key))),note:text(500).optional(),
}).strict();
export const BridgeDiscovery=z.object({items:z.array(FoundBridgeDevice).max(256),warnings:z.array(text(500)).max(16)}).strict();
export type FoundBridgeDevice=z.infer<typeof FoundBridgeDevice>;
export type BridgeDiscovery=z.infer<typeof BridgeDiscovery>;

const lanPorts:Record<string,string>={"gcode-laser":"23",moonraker:"7125",octoprint:"80",prusalink:"80",duet:"80"};
export function bridgeDiscoveryIdentity(config:Record<string,unknown>):string|null{
 const read=(key:string)=>typeof config[key]==="string"&&config[key].length<=512&&!/[\x00-\x1f]/.test(config[key])?config[key].trim():"";
 const driver=read("driver");if(!driver)return null;
 const serial=read("usbSerial"),path=read("path"),host=read("host");
 if(serial)return JSON.stringify([driver,"usb",serial]);
 if(path)return JSON.stringify([driver,"serial",/^com\d+$/i.test(path)?path.toUpperCase():path]);
 if(host)return JSON.stringify([driver,"lan",host.toLowerCase(),read("port")||lanPorts[driver]||""]);
 return null;
}
