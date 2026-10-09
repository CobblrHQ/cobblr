import {resolve} from "node:path";
import {serverBridgeAvailability} from "../platform/server-bridge-policy.js";
import {ServerBridgeSupervisor,launchServerBridge} from "../platform/server-bridge-supervisor.js";
async function main():Promise<void>{
 if(!serverBridgeAvailability(process.env).available)throw new Error("The server bridge needs a configured self-hosted instance.");
 const supervisor=new ServerBridgeSupervisor({directory:resolve(process.env.COBBLR_SERVER_BRIDGE_DIR!),cache:resolve(process.env.COBBLR_SERVER_BRIDGE_CACHE_DIR||"./data/server-bridge-cache"),launch:launchServerBridge});
 let stopping=false;const stop=()=>{stopping=true;void supervisor.stop();};process.once("SIGTERM",stop);process.once("SIGINT",stop);
 try{
  while(!stopping){await supervisor.reconcile();if(!stopping)await new Promise(resolve=>setTimeout(resolve,2000));}
 }finally{stopping=true;await supervisor.stop();process.removeListener("SIGTERM",stop);process.removeListener("SIGINT",stop);}
}
void main().catch(()=>{console.error("[server-bridge] the service could not start");process.exitCode=1;});
