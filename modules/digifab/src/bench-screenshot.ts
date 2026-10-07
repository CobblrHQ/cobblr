import { crc32, deflateSync } from "node:zlib";
const invalid=()=>new Error("The scope did not return a supported, complete bitmap.");
export function scopeScreenshotPng(bytes:Buffer):Buffer {
 if(bytes.length<54||bytes.length>2*1024*1024||bytes.toString("ascii",0,2)!=="BM"||bytes.readUInt32LE(2)!==bytes.length)throw invalid();
 const offset=bytes.readUInt32LE(10),header=bytes.readUInt32LE(14),width=bytes.readInt32LE(18),signedHeight=bytes.readInt32LE(22),height=Math.abs(signedHeight),depth=bytes.readUInt16LE(28);
 if(header<40||14+header>offset||offset>bytes.length||width<1||height<1||width>8192||height>8192||width*height>2000000||bytes.readUInt16LE(26)!==1||bytes.readUInt32LE(30)!==0||![8,24,32].includes(depth))throw invalid();
 const stride=Math.ceil(width*depth/32)*4;
 if(offset+stride*height>bytes.length)throw invalid();
 const palette=depth===8?(bytes.readUInt32LE(46)||256):0;
 if(palette>256||depth===8&&14+header+palette*4>offset)throw invalid();
 const rows=Buffer.alloc((width*4+1)*height);
 for(let y=0;y<height;y++){
  const from=offset+(signedHeight>0?height-1-y:y)*stride,to=y*(width*4+1)+1;
  for(let x=0;x<width;x++){
   const index=bytes[from+x]!,pixel=depth===8?14+header+index*4:from+x*(depth/8);
   if(depth===8&&index>=palette)throw invalid();
   rows[to+x*4]=bytes[pixel+2]!;rows[to+x*4+1]=bytes[pixel+1]!;rows[to+x*4+2]=bytes[pixel]!;rows[to+x*4+3]=255;
  }
 }
 const chunk=(type:string,data:Buffer)=>{
  const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length,0);out.write(type,4,4,"ascii");data.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,out.length-4)),out.length-4);return out;
 };
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(rows)),chunk("IEND",Buffer.alloc(0))]);
}
