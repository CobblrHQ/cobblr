import {unlink} from "node:fs/promises";
import {join,resolve} from "node:path";
import {z} from "zod";
export async function removeServerBridgeEnrollment(orgId:string,directory=process.env.COBBLR_SERVER_BRIDGE_DIR||""):Promise<void>{
 const id=z.string().uuid().parse(orgId);if(!directory.trim())return;
 try{await unlink(join(resolve(directory),`${id}.json`));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
}
