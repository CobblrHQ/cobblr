import {randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile,rename,unlink} from "node:fs/promises";
import {join,resolve} from "node:path";
import {z} from "zod";
import {meta} from "../db/meta.js";
import {mintTokenString} from "../auth/api-tokens.js";
import {SERVER_BRIDGE_ID,type ServerBridgeState} from "@cobblr/platform-contract/server-bridge";
import {bridgeTokenName} from "@cobblr/platform-contract/edge-channel";
import {serverBridgeAvailability} from "./server-bridge-policy.js";
import {ServerBridgeConfig} from "@cobblr/platform-contract/server-bridge";

const source="server bridge";
const bridge=SERVER_BRIDGE_ID;
function configPath(orgId:string):string{return join(resolve(process.env.COBBLR_SERVER_BRIDGE_DIR!),`${z.string().uuid().parse(orgId)}.json`);}
export async function serverBridgeState(orgId:string):Promise<ServerBridgeState>{
 const availability=serverBridgeAvailability(process.env);
 if(!availability.available)return {...availability,enabled:false,bridge};
 const token=await meta.selectFrom("api_tokens").select("id").where("source","=",source).where("org_id","=",orgId).where("revoked_at","is",null).executeTakeFirst();
 let configured=false;
 if(token)try{const config=ServerBridgeConfig.parse(JSON.parse(await readFile(configPath(orgId),"utf8")));configured=config.orgId===orgId&&config.tokenId===token.id;}catch{}
 return {...availability,enabled:!!token&&configured,bridge};
}
export async function setServerBridge(p:{orgId:string;slug:string;userId:string;enabled:boolean}):Promise<void>{
 if(!serverBridgeAvailability(process.env).available)throw new Error("The server bridge is available only on a configured self-hosted instance.");
 const target=configPath(p.orgId);
 await meta.transaction().execute(async trx=>{
  await trx.selectFrom("orgs").select("id").where("id","=",p.orgId).forUpdate().executeTakeFirstOrThrow();
  if(!p.enabled){
   await trx.updateTable("api_tokens").set({revoked_at:new Date()}).where("source","=",source).where("org_id","=",p.orgId).where("revoked_at","is",null).execute();
   try{await unlink(target);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   return;
  }
  const existing=await trx.selectFrom("api_tokens").select("id").where("source","=",source).where("org_id","=",p.orgId).where("revoked_at","is",null).executeTakeFirst();
  if(existing)try{const config=ServerBridgeConfig.parse(JSON.parse(await readFile(target,"utf8")));if(config.orgId===p.orgId&&config.tokenId===existing.id)return;}catch{}
  const {plaintext,hash,tokenPrefix}=mintTokenString();
  const origin=new URL(process.env.COBBLR_SERVER_BRIDGE_ORIGIN||"http://api:4000");
  if(!["http:","https:"].includes(origin.protocol)||origin.username||origin.password)throw new Error("Configure a plain HTTP or HTTPS server bridge origin.");
  const relay=new URL(`/api/v1/orgs/${encodeURIComponent(p.slug)}/edge`,origin).href;
  await trx.updateTable("api_tokens").set({revoked_at:new Date()}).where("source","=",source).where("org_id","=",p.orgId).where("revoked_at","is",null).execute();
  // check-then-insert: the workspace row lock serializes enrollment, and each token has a fresh random identity.
  const token=await trx.insertInto("api_tokens").values({user_id:p.userId,name:bridgeTokenName("Cobblr Server"),token_hash:hash,token_prefix:tokenPrefix,expires_at:null,scopes:["devices:edge"],source,meta:{bridge},org_id:p.orgId,access:"full"}).returning("id").executeTakeFirstOrThrow();
  const config=ServerBridgeConfig.parse({orgId:p.orgId,tokenId:token.id,relay,token:plaintext,bridge});
  await mkdir(resolve(process.env.COBBLR_SERVER_BRIDGE_DIR!),{recursive:true,mode:0o700});
  const temp=`${target}.${randomUUID()}.tmp`;
  try{await writeFile(temp,JSON.stringify(config),{mode:0o600});await rename(temp,target);}finally{await unlink(temp).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});}
 });
}
