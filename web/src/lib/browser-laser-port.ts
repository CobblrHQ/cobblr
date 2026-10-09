import type {GcodeStream} from "@cobblr/digifab/laser-session";
import type {LaserControllerTransport} from "@cobblr/digifab/laser-controller";
import type {SerialPortLike} from "@cobblr/platform-web";
class BrowserLaserStream implements GcodeStream {
 private data=new Set<(bytes:Uint8Array)=>void>();
 private errors=new Set<(error:Error)=>void>();
 private closes=new Set<()=>void>();
 private reader:ReadableStreamDefaultReader<Uint8Array>;
 private writer:WritableStreamDefaultWriter<Uint8Array>;
 private closed=false;
 private closing:Promise<void>|null=null;
 constructor(private port:SerialPortLike){
  if(!port.readable||!port.writable)throw new Error("The serial port has no readable and writable streams.");
  this.reader=port.readable.getReader();this.writer=port.writable.getWriter();void this.read();
 }
 on(event:"data",listener:(bytes:Uint8Array)=>void):this;
 on(event:"error",listener:(error:Error)=>void):this;
 on(event:"close",listener:()=>void):this;
 on(event:"data"|"error"|"close",listener:((bytes:Uint8Array)=>void)|((error:Error)=>void)|(()=>void)):this{
  if(event==="data")this.data.add(listener as (bytes:Uint8Array)=>void);
  else if(event==="error")this.errors.add(listener as (error:Error)=>void);
  else this.closes.add(listener as ()=>void);
  return this;
 }
 once(_event:"close",listener:()=>void):this{
  const call=()=>{this.closes.delete(call);listener();};this.closes.add(call);return this;
 }
 write(bytes:string|Uint8Array,callback?:(error?:Error|null)=>void):void{
  if(this.closed){callback?.(new Error("The browser serial port is closed."));return;}
  void this.writer.write(typeof bytes==="string"?new TextEncoder().encode(bytes):bytes).then(()=>callback?.(),error=>{
   const failure=error instanceof Error?error:new Error("The browser serial write failed.");callback?.(failure);this.destroy(failure);
  });
 }
 private async read():Promise<void>{
  try{
   while(!this.closed){const result=await this.reader.read();if(result.done)break;for(const listener of this.data)listener(result.value);}
   if(!this.closed)this.destroy(new Error("The USB controller disconnected."));
  }catch(error){if(!this.closed)this.destroy(error instanceof Error?error:new Error("The browser serial read failed."));}
 }
 destroy(error?:Error):void{
  if(this.closed)return;this.closed=true;
  if(error)for(const listener of this.errors)listener(error);
  for(const listener of [...this.closes])listener();this.closes.clear();
  void this.close().catch(()=>{});
 }
 close():Promise<void>{
  if(this.closing)return this.closing;
  this.closed=true;
  this.closing=(async()=>{
   await this.reader.cancel().catch(()=>{});this.reader.releaseLock();
   await this.writer.abort().catch(()=>{});this.writer.releaseLock();
   await this.port.close();
  })();return this.closing;
 }
}
export async function openBrowserLaserPort(port:SerialPortLike):Promise<LaserControllerTransport>{
 if(!port.readable&&!port.writable)await port.open({baudRate:115200});
 try{const stream=new BrowserLaserStream(port);return {stream,close:()=>stream.close()};}
 catch(error){await port.close().catch(()=>{});throw error;}
}
