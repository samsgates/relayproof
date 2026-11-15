import { z } from "zod";
import { moduleIds, type ModuleId } from "./catalog";

const id=z.string().trim().min(1).max(150);
const text=z.string().trim().min(1).max(300);
const date=z.iso.datetime({offset:true});
const count=z.number().int().min(0).max(1_000_000_000);
const seconds=z.number().int().min(0).max(31_536_000);
const rows=<T extends z.ZodType>(item:T)=>z.array(item).max(5000);
const url=z.url().refine(s=>s.startsWith("https://")).optional();
const reference=z.object({name:text,url});
const int=(min:number,max:number,initial:number)=>z.number().int().min(min).max(max).default(initial);
export const baseConfig=z.object({
  intervalMinutes:int(5,1440,5), graceMinutes:int(0,1440,15),
  severity:z.enum(["critical","high","medium","low"]).default("high"),
  ownerId:z.uuid().optional(),
  settings:z.record(z.string(),z.unknown()).default({}),
  source:z.enum(["live","evidence"]).default("evidence"),
});
export type Config=z.infer<typeof baseConfig>;
const empty=z.object({});
export const liveSchema={
  tickets:z.object({
    groupId:z.string().regex(/^[0-9a-f]{32}$/i), projectId:z.string().regex(/^\d{1,20}$/),
    projectKey:z.string().regex(/^[A-Z][A-Z0-9]{1,19}$/),
    jiraField:z.string().regex(/^customfield_\d{1,20}$/),
    sourceField:z.string().regex(/^(sys_id|number|u_[a-z0-9_]{1,80})$/).default("sys_id"),
    eligibleField:z.string().regex(/^u_[a-z0-9_]{1,80}$/).optional(),
    includedPriorities:z.array(z.enum(["1","2","3","4","5"])).min(1).default(["1","2"]),
    statusMap:z.record(z.string(),z.array(id).min(1)).refine(o=>Object.keys(o).length>0,"Provide a status map"),
    lookbackDays:int(1,90,30), maxRecords:int(10,5000,2000),
  }),
  changes:z.object({repository:z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),environment:id,
    changeField:z.string().regex(/^u_[a-z0-9_]{1,80}$/), approvalTimeField:z.string().regex(/^u_[a-z0-9_]{1,80}$/),
    lookbackDays:int(1,90,30)}),
  offboarding:z.object({identityField:z.string().regex(/^u_[a-z0-9_]{1,80}$/),dueField:z.string().regex(/^u_[a-z0-9_]{1,80}$/),
    groupId:z.string().regex(/^[0-9a-f]{32}$/i),appResourceIds:z.array(z.uuid()).max(20).default([]),lookbackDays:int(1,90,30)}),
  cmdb:z.object({region:z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),className:z.string().regex(/^cmdb_ci_[a-z0-9_]{1,80}$/),
    resourceField:z.string().regex(/^(object_id|u_[a-z0-9_]{1,80})$/), ownerTag:id.default("Owner"),
    scopeField:z.string().regex(/^u_[a-z0-9_]{1,80}$/),scopeValue:z.string().regex(/^[a-zA-Z0-9_.:@/-]{1,100}$/)}),
  sla:z.object({minutes:int(1,1440,60),slaId:z.string().regex(/^[0-9a-f]{32}$/i)}),
  msp:empty,claims:empty,upgrade:empty,knowledge:empty,
} satisfies Record<ModuleId,z.ZodType>;
export const schemas={
  tickets:z.object({
    incidents:rows(z.object({id, number:id, correlation:id.nullable(), state:id.nullable(), priority:id, eligibleAt:date.optional(), createdAt:date, updatedAt:date, url})),
    issues:rows(z.object({id,key:id,correlation:id.nullable(),status:id.nullable(),updatedAt:date,url})),
    coverage:z.boolean().default(true), statusMap:z.record(z.string(),z.array(id)).optional(),
  }),
  changes:z.object({
    complete:z.boolean(), deployments:rows(z.object({id, name:text,time:date,changeId:id.optional(),emergency:z.boolean().default(false),url})),
    approvals:rows(z.object({id,approved:z.boolean(),time:date.optional(),emergencyAllowed:z.boolean().default(false),url})),
  }),
  offboarding:z.object({
    exits:rows(z.object({id,dueAt:date,completed:z.boolean(),accountEnabled:z.boolean().nullable(),remainingApps:z.array(id).max(100).nullable(),url})),
  }),
  cmdb:z.object({
    complete:z.boolean(),cloud:rows(z.object({id,state:z.enum(["active","retired"]),owner:id.optional(),url})),
    cmdb:rows(z.object({id,resourceId:id,owner:id.optional(),state:z.enum(["active","retired"]).default("active"),url})),
  }),
  sla:z.object({
    minutes:int(1,1440,60),tasks:rows(z.object({id,deadline:date,paused:z.boolean(),closed:z.boolean(),owner:id.optional(),url})),
  }),
  msp:z.object({
    period:text, tickets:rows(z.object({id,eligible:z.boolean(),breached:z.boolean(),closed:z.boolean(),resolutionMinutes:count.optional(),url})),
    customerSignoff:reference.optional(),
  }),
  claims:z.object({
    period:text,currency:z.string().regex(/^[A-Z]{3}$/),feeMinor:count,capMinor:count,claimDeadline:date,
    termsApproved:z.literal(true),terms:rows(z.object({id,description:text,page:z.number().int().positive(),
      thresholdSeconds:seconds,creditBasisPoints:z.number().int().min(0).max(10000)})).refine(a=>new Set(a.map(t=>t.id)).size===a.length,"Term IDs must be unique"),
    incidents:rows(z.object({id,termId:id,measuredSeconds:seconds,excluded:z.boolean(),url})).refine(a=>new Set(a.map(f=>f.id+":"+f.termId)).size===a.length,"Duplicate incident and term")
  }).refine(a=>a.incidents.every(i=>a.terms.some(t=>t.id===i.termId)),"Every incident must reference an approved term"),
  upgrade:z.object({
    release:text, flows:rows(z.object({id,name:text,owner:id,test:z.enum(["pass","fail","missing"]),signedOff:z.boolean(),reviewer:id.optional(),url})),
  }),
  knowledge:z.object({
    category:text,publishedAt:date,article:reference,articleViews:count.optional(),
    before:z.object({total:count,repeat:count,days:z.number().int().positive()}),
    after:z.object({total:count,repeat:count,days:z.number().int().positive()}), notes:text.optional(),
  }).refine(x=>x.before.repeat<=x.before.total && x.after.repeat<=x.after.total,"Repeat counts must be within total request volume"),
} satisfies Record<ModuleId,z.ZodType>;
export type Inputs={ [K in ModuleId]:z.output<(typeof schemas)[K]> };

export const ruleInput=z.object({name:text,module:z.enum(moduleIds),config:baseConfig});
export function validateRule(module:ModuleId,config:Config):Config {
  if(config.source==="live" && ["msp","claims","upgrade","knowledge"].includes(module))
    throw new Error("This module requires reviewed evidence input.");
  if(config.source==="live") return {...config, settings:liveSchema[module].parse(config.settings)};
  return config;
}
export type Result = {
  subject:string; kind:string; title:string; outcome:"pass"|"fail"|"unknown";
  dueAt?:string; evidence:Record<string,unknown>; confirmations?:1|2; recovery?:1|2;
};
export type Analysis={ findings:Result[]; report:Record<string,unknown> };
function analysis(findings:Result[],report:Record<string,unknown>={}):Analysis {
  return {findings,report};
}
const row=(subject:string,kind:string,title:string,outcome:Result["outcome"],evidence:Result["evidence"]):Result=>
  ({subject,kind,title,outcome,evidence});
const byId=<T extends {id:string}>(list:T[])=>[...new Map(list.map(item=>[item.id,item])).values()];
const group=<T>(list:T[], getKey:(item:T)=>string|null)=>{
  const map=new Map<string,T[]>();
  for(const item of list) {
    const key=getKey(item);
    if(key===null) continue;
    const items=map.get(key)??[];
    items.push(item);
    map.set(key,items);
  }
  return map;
};
const iso=(value:number)=>new Date(value).toISOString();

export function evaluateTickets(raw:unknown, config:Config, clock:Date, firstSeen:Map<string,Date>=new Map()):Analysis {
  const input=schemas.tickets.parse(raw);
  const mappings=input.statusMap??z.record(z.string(),z.array(z.string())).parse(config.settings.statusMap??{});
  const targets=group(byId(input.issues),issue=>issue.correlation);
  const incidents=byId(input.incidents);
  const sources=group(incidents,incident=>incident.correlation);
  const results:Result[]=[];
  for(const incident of incidents) {
    const key=incident.correlation;
    const matches=key===null?[]:targets.get(key)??[];
    const ambiguity=Boolean(key && (sources.get(key)?.length??0)>1);
    const baseEvidence={source:incident.number,sourceUrl:incident.url,sourceId:incident.id,correlation:key,
      target:matches.slice(0,15).map(item=>({id:item.id,key:item.key,status:item.status,url:item.url})),matchCount:matches.length,
      observedAt:clock.toISOString(),coverage:input.coverage};
    const evidenceAvailable=input.coverage && key!==null && !ambiguity;
    const eligible=incident.eligibleAt ? Date.parse(incident.eligibleAt) : firstSeen.get(incident.id)?.getTime() ?? clock.getTime();
    const due=eligible+config.graceMinutes*60000;
    const common={...baseEvidence,eligibleAt:iso(eligible),clockSource:incident.eligibleAt?"source":"first_observed",dueAt:iso(due)};
    const eligibleOutcome=(outcome:"pass"|"fail")=>evidenceAvailable && due<=clock.getTime()?outcome:"unknown";
    const allowed=incident.state===null?undefined:mappings[incident.state];
    const single=matches.length===1?matches[0]:undefined;
    const isKnown=allowed && single?.status!==null && single?.status!==undefined;
    const status=single && isKnown ? eligibleOutcome(allowed.includes(single.status!)?"pass":"fail") : "unknown";
    const candidates=[
      {...row(incident.id,"missing","Missing Jira handoff",eligibleOutcome(matches.length===0?"fail":"pass"),common),confirmations:2 as const,recovery:2 as const,dueAt:iso(due)},
      {...row(incident.id,"duplicate","Duplicate Jira issues",eligibleOutcome(matches.length>1?"fail":"pass"),common),confirmations:2 as const,recovery:2 as const,dueAt:iso(due)},
      {...row(incident.id,"status","Status mismatch",status,{...common,actual:single?.status,expected:allowed,sourceState:incident.state}),confirmations:2 as const,recovery:2 as const},
      {...row(incident.id,"mapping","Correlation or status mapping needs review",
        !input.coverage?"unknown":key===null||ambiguity||!allowed||(single?.status===null)?"fail":"pass",
        {...common,ambiguousSource:ambiguity,missingMapping:!allowed}),confirmations:2 as const,recovery:2 as const},
    ];
    results.push(...candidates);
  }
  return analysis(results,{incidents:input.incidents.length,jiraIssues:input.issues.length,coverage:input.coverage});
}

export function evaluate(module:ModuleId, sample:unknown, config:Config, clock=new Date(), firstSeen?:Map<string,Date>):Analysis {
  switch(module) {
    case "tickets": return evaluateTickets(sample,config,clock,firstSeen);
    case "changes": {
      const input=schemas.changes.parse(sample);
      const approvals=new Map(input.approvals.map(a=>[a.id,a]));
      return analysis(byId(input.deployments).map(item=>{
        const approval=item.changeId ? approvals.get(item.changeId):undefined;
        const valid=approval?.approved && (item.emergency && approval.emergencyAllowed ||
          Boolean(approval.time && Date.parse(approval.time)<=Date.parse(item.time)));
        return row(item.id,"change","Deployment approval evidence",input.complete ? valid?"pass":"fail":"unknown",{deployment:item,approval});
      }),{deployments:input.deployments.length,approvals:input.approvals.length,complete:input.complete});
    }
    case "offboarding": {
      const items=byId(schemas.offboarding.parse(sample).exits);
      return analysis(items.map(x=>row(x.id,"access","Access remains after offboarding",
        !x.completed || Date.parse(x.dueAt)>clock.getTime() || x.accountEnabled===null || x.remainingApps===null ? "unknown" :
          x.accountEnabled || x.remainingApps.length>0?"fail":"pass",{case:x})),{verifiedCases:items.length});
    }
    case "cmdb": {
      const i=schemas.cmdb.parse(sample);
      const assets=new Map(byId(i.cloud).map(x=>[x.id,x]));
      const cis=group(byId(i.cmdb),x=>x.resourceId);
      const resources=new Set([...assets.keys(),...cis.keys()]);
      return analysis([...resources].map(id=>{
        const asset=assets.get(id), records=cis.get(id)??[];
        const active=records.filter(x=>x.state==="active");
        const mismatch=asset?.state==="active"?active.length!==1||Boolean(asset.owner&&active[0]?.owner!==asset.owner):active.length>0;
        return row(id,"inventory","Cloud inventory discrepancy",!i.complete?"unknown":mismatch?"fail":"pass",{asset,records:records.slice(0,15)});
      }),{cloud:i.cloud.length,configurationItems:i.cmdb.length,complete:i.complete});
    }
    case "sla": {
      const i=schemas.sla.parse(sample);
      const results=byId(i.tasks).map(x=>{
        const remaining=Math.floor((Date.parse(x.deadline)-clock.getTime())/60000);
        return row(x.id,"deadline","SLA deadline needs intervention",x.closed||x.paused?"pass":remaining<=i.minutes?"fail":"pass",
          {task:x,minutesRemaining:remaining,recommendedAction:x.owner?"Ask assigned owner to review":"Assign an accountable owner"});
      });
      return analysis(results,{tasks:i.tasks.length,interventions:results.filter(x=>x.outcome==="fail").length});
    }
    case "msp": {
      const i=schemas.msp.parse(sample), tickets=byId(i.tickets);
      const eligible=tickets.filter(x=>x.eligible), breaches=eligible.filter(x=>x.breached);
      const timings=tickets.flatMap(x=>x.closed&&x.resolutionMinutes!==undefined?[x.resolutionMinutes]:[]);
      return analysis([],{period:i.period, tickets:tickets.length, eligible:eligible.length, breaches:breaches.length,
        breachRate:eligible.length ? breaches.length/eligible.length : null, averageResolutionMinutes:timings.length ? timings.reduce((a,b)=>a+b,0)/timings.length : null,
        signoff:i.customerSignoff??null,breachEvidence:breaches.slice(0,30).map(t=>({id:t.id,url:t.url}))});
    }
    case "claims": {
      const i=schemas.claims.parse(sample), terms=new Map(i.terms.map(t=>[t.id,t]));
      const calculations=i.incidents.flatMap(x=>{
        const term=terms.get(x.termId);
        return term&&!x.excluded&&x.measuredSeconds>term.thresholdSeconds ?
          [{incident:x.id, recordUrl:x.url,term:term.id,page:term.page,amountMinor:Math.floor(i.feeMinor*term.creditBasisPoints/10000)}]:[];
      });
      const subtotalMinor=calculations.reduce((sum,x)=>sum+x.amountMinor,0);
      return analysis([],{state:"prepared_for_review",period:i.period,currency:i.currency,claimDeadline:i.claimDeadline,
        deadlinePassed:Date.parse(i.claimDeadline)<clock.getTime(),subtotalMinor,capMinor:i.capMinor,claimMinor:Math.min(i.capMinor,subtotalMinor),
        qualifyingIncidents:calculations.length,calculations:calculations.slice(0,100),calculationRowsOmitted:Math.max(0,calculations.length-100)});
    }
    case "upgrade": {
      const i=schemas.upgrade.parse(sample),flows=byId(i.flows);
      const results=flows.map(x=>row(x.id,"readiness","Critical workflow needs sign-off",
        x.test==="pass"&&x.signedOff&&x.reviewer?"pass":"fail",{release:i.release,workflow:x}));
      return analysis(results,{release:i.release,ready:flows.length>0&&results.every(x=>x.outcome==="pass"),workflows:flows.length});
    }
    case "knowledge": {
      const i=schemas.knowledge.parse(sample);
      const before=i.before.total?100*i.before.repeat/i.before.total:null;
      const after=i.after.total?100*i.after.repeat/i.after.total:null;
      return analysis([],{category:i.category,article:i.article,publishedAt:i.publishedAt,articleViews:i.articleViews??null,
        before:i.before,after:i.after,beforePer100:before,afterPer100:after,deltaPer100:before!==null&&after!==null?after-before:null,
        smallSample:Math.min(i.before.total,i.after.total)<100,notes:i.notes??null});
    }
  }
}
