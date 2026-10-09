import {z} from "zod";
export function serverBridgeAvailability(env:Record<string,string|undefined>):{available:boolean;reason:"cloud"|"not_configured"|null}{
 const hosted=z.enum(["true","false"]).parse(env.COBBLR_HOSTED||"false")==="true";
 if(hosted)return {available:false,reason:"cloud"};
 const enabled=z.enum(["true","false"]).parse(env.COBBLR_SERVER_BRIDGE_ENABLED||"false")==="true";
 if(!enabled||!env.COBBLR_SERVER_BRIDGE_DIR?.trim())return {available:false,reason:"not_configured"};
 return {available:true,reason:null};
}
