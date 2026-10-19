import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  module: "digifab",
  name:"read_bench",description:"Read a bench instrument and paged readings.",mode:"read",paging:{by:"cursor"},
  params:{machine_id:z.string().uuid(),cursor:CURSOR_PARAM},
  execute:async(api,args)=>{
    const cursor=decodeCursor<{offset:number;machine_id:string}>("read_bench",args.cursor);
    if(!cursor.ok)return toolFail(cursor.error);
    if(cursor.state&&cursor.state.machine_id!==args.machine_id)return toolFail("Use this instrument's cursor, or omit it to start again.");
    const offset=cursor.state?.offset || 0;
    const result=await api.request("GET",`/modules/digifab/bench/${encodeURIComponent(String(args.machine_id))}?limit=20&offset=${offset}`);
    if(result.status>=400)return toolFail(apiErrorMessage(result,"Could not read the bench"));
    const items=Array.isArray(result.body.items)?result.body.items:[];
    const next=offset+items.length<Number(result.body.total)&&items.length?{offset:offset+items.length,machine_id:String(args.machine_id)}:null;
    return toolOk({...result.body,...pageEnd("read_bench",next)});
  },
};

export default tool;
