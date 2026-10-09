export function stationManifest(start:string){
 if(typeof start!=="string"||start.length>512||!/^\/w\/[a-z0-9-]+\/station\/machine\/[0-9a-f-]{36}\/[a-zA-Z0-9%._~-]+\/?$/.test(start))throw new Error("Choose a machine station URL.");
 const url=new URL(start,"https://station.example");if(url.pathname!==start)throw new Error("Choose a machine station URL.");
 const path=start.replace(/\/$/,"")+"/";
 return {id:path,name:"Cobblr machine station",short_name:"Machine station",description:"Run and check jobs at this machine.",start_url:path,scope:path,display:"standalone",background_color:"#3D4451",theme_color:"#3D4451",icons:[{src:"/icon-192.png",sizes:"192x192",type:"image/png",purpose:"any"},{src:"/icon-512.png",sizes:"512x512",type:"image/png",purpose:"any"},{src:"/icon-maskable-512.png",sizes:"512x512",type:"image/png",purpose:"maskable"}]};
}
