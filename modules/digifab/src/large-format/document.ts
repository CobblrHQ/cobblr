import {PDFDocument,PDFName,PDFNumber} from "pdf-lib";
import {inflateSync} from "node:zlib";
function boundedPng(b:Buffer) {
 if(b.length<33||b.toString("ascii",12,16)!=="IHDR")throw new Error("Choose a valid PNG image.");
 const width=b.readUInt32BE(16),height=b.readUInt32BE(20);
 if(!width||!height||width>16384||height>16384||width*height>16000000)throw new Error("Use a PNG up to 16 million pixels, or choose a JPEG or PDF.");
 const chunks:Buffer[]=[];for(let offset=8;offset+12<=b.length;){const length=b.readUInt32BE(offset),end=offset+12+length;if(end>b.length)throw new Error("Choose a complete PNG image.");if(b.toString("ascii",offset+4,offset+8)==="IDAT")chunks.push(b.subarray(offset+8,end-4));offset=end;}
 try{inflateSync(Buffer.concat(chunks),{maxOutputLength:width*height*8+(height+1)*8+1024});}catch{throw new Error("PNG pixel data is invalid or exceeds its bounded dimensions.");}
}
export async function printDocument(bytes:Uint8Array,filename:string,size:{width_mm?:number;height_mm?:number}) {
 if(bytes.length<8||bytes.length>20*1024*1024)throw new Error("Choose a PDF or image smaller than 20 MB.");
 const b=Buffer.from(bytes);
 if(/\.pdf$/i.test(filename)&&b.subarray(0,5).equals(Buffer.from("%PDF-"))) {
  const pdf=await PDFDocument.load(bytes),pages=pdf.getPages();
  if(!pages.length||pages.length>1000)throw new Error("Choose a PDF with 1 to 1000 pages.");
  const boxes=pages.map(p=>{
   if((p.node.lookupMaybe(PDFName.of("UserUnit"),PDFNumber)?.asNumber()??1)!==1)throw new Error("Export a PDF with standard page units, or use the vendor RIP.");
   const box=p.getMediaBox(),crop=p.getCropBox(),rotation=p.getRotation().angle;
   if(!Object.values(box).concat(Object.values(crop)).every(Number.isFinite))throw new Error("Choose a PDF with finite page dimensions.");
   if((["x","y","width","height"] as const).some(k=>Math.abs(box[k]-crop[k])>0.01))throw new Error("Export a PDF without cropped page boxes, or use the vendor RIP.");
   if(!Number.isSafeInteger(rotation)||rotation%90!==0)throw new Error("Use PDF page rotation in 90 degree steps.");
   const size=rotation%180!==0?{width:box.height,height:box.width}:{width:box.width,height:box.height};
   if(![size.width,size.height].every(n=>Number.isFinite(n)&&n>0&&n*25.4/72<=10000))throw new Error("Use PDF pages smaller than 10000 mm on each edge.");
   return size;
  }),first=boxes[0]!;
  if(boxes.some(p=>Math.abs(p.width-first.width)>0.01||Math.abs(p.height-first.height)>0.01))throw new Error("Split a PDF with different page sizes into separate print jobs.");
  return {bytes,format:"application/pdf" as const,width_mm:first.width*25.4/72,height_mm:first.height*25.4/72,pages:pages.length};
 }
 const format=/\.png$/i.test(filename)&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"image/png" as const:/\.jpe?g$/i.test(filename)&&b[0]===255&&b[1]===216?"image/jpeg" as const:null;
 if(!format||![size.width_mm,size.height_mm].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>0&&n<=10000))throw new Error("Choose a PDF, PNG or JPEG. Give images their output width and height in millimetres.");
 if(format==="image/png")boundedPng(b);
 const pdf=await PDFDocument.create(),image=format==="image/png"?await pdf.embedPng(bytes):await pdf.embedJpg(bytes);
 const width=size.width_mm!*72/25.4,height=size.height_mm!*72/25.4;pdf.addPage([width,height]).drawImage(image,{x:0,y:0,width,height});
 const document=await pdf.save();if(document.length>20*1024*1024)throw new Error("Keep the prepared image PDF below 20 MB.");
 return {bytes:document,format:"application/pdf" as const,width_mm:size.width_mm!,height_mm:size.height_mm!,pages:1};
}
