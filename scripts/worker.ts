import { setTimeout as wait } from "node:timers/promises";
import { cleanTenants, processJob, sanitizeWorkerError } from "../lib/worker";
import { dispatch, finish, lease, renew } from "../lib/jobs";
import { pool } from "../lib/db";

let stopping=false, lastDispatch=0, lastCleanup=0;
for(const signal of ["SIGTERM","SIGINT"] as const) process.on(signal,()=>{stopping=true;});
console.log(JSON.stringify({event:"worker.started"}));
while(!stopping){
  try{
    if(Date.now()-lastDispatch>10000){await dispatch();lastDispatch=Date.now();}
    if(Date.now()-lastCleanup>60000){await cleanTenants();lastCleanup=Date.now();}
    const job=await lease();
    if(!job){await wait(1200);continue;}
    const heartbeat=setInterval(()=>{void renew(job).catch(()=>undefined);},25000);
    try {
      await processJob(job);
      await finish(job);
      console.log(JSON.stringify({event:"job.succeeded",id:job.id,kind:job.kind}));
    } catch(error){
      const failure=sanitizeWorkerError(error,job.attempts);
      await finish(job,failure);
      console.error(JSON.stringify({event:"job.failed",id:job.id,kind:job.kind,code:failure.code}));
    } finally{clearInterval(heartbeat);}
  } catch{
    console.error(JSON.stringify({event:"worker.loop_failed"}));
    await wait(4000);
  }
}
await pool().end();
