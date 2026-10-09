import type {SerialPortLike} from "@cobblr/platform-web";
export function browserGrblFixture(){
 const written:string[]=[];let closed=0,state="Idle",line="";
 let readable:ReadableStream<Uint8Array>|null=null,writable:WritableStream<Uint8Array>|null=null;
 let receive:ReadableStreamDefaultController<Uint8Array>;
 const say=(value:string)=>receive.enqueue(new TextEncoder().encode(value+"\n"));
 const port:SerialPortLike={
  get readable(){return readable;},get writable(){return writable;},
  open:async()=>{
   readable=new ReadableStream({start:controller=>{receive=controller;}});
   writable=new WritableStream({write:bytes=>{
    for(const byte of bytes){
     if(byte===63){say(`<${state}|MPos:0,0,0|FS:0,0>`);continue;}
     if(byte===24){line="";state="Idle";written.push("RESET");say("Grbl 1.1h");continue;}
     if(byte===33){state="Hold";written.push("HOLD");continue;}
     if(byte===126){state="Run";written.push("RESUME");continue;}
     if(byte===13)continue;
     if(byte!==10){line+=String.fromCharCode(byte);continue;}
     const command=line;line="";written.push(command);
     if(command==="$$")say("$30=1000\n$31=0\n$32=1\n$22=0");
     if(command==="$I")say("[VER:1.1h:fixture]");
     if(/^G1 /.test(command))state="Run";
     if(command==="G4 P0.01"||command==="M5")state="Idle";
     say("ok");
    }
   }});
  },
  close:async()=>{closed++;readable=null;writable=null;},
 };
 return {port,written,closed:()=>closed};
}
