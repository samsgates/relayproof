import { one } from "./db";
import { inScope, type Scope } from "./auth";
import { missing } from "./http";
import { z } from "zod";

type SummaryCount={total:number;critical:number;assigned:number;resolved:number};
const occurrenceRank="CASE f.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END";
export type Occurrence={
  id:string;title:string;subject:string;kind:string;severity:string;state:string;opened_at:Date;closed_at:Date|null;
  rule:string;owner:string|null;owner_id:string|null;rank:number;version:number;suppressed_until:Date|null;closure_reason:string|null;
};
const occurrenceColumns=`o.*,f.title,f.subject,f.kind,f.severity,r.name AS rule,u.name AS owner,${occurrenceRank} AS rank`;
const occurrenceJoin=`FROM occurrences o JOIN findings f ON f.tenant_id=o.tenant_id AND f.id=o.finding_id
  JOIN rules r ON r.tenant_id=f.tenant_id AND r.id=f.rule_id LEFT JOIN users u ON u.id=o.owner_id`;
export const states=["open","acknowledged","suppressed","resolved","dismissed"] as const;
export const severities=["critical","high","medium","low"] as const;
const filtersSchema=z.object({state:z.enum(states).optional(),severity:z.enum(severities).optional(),
  owner:z.union([z.uuid(),z.literal("unassigned")]).optional(),rule:z.uuid().optional(),from:z.iso.date().optional(),to:z.iso.date().optional()});
export const validFilters=filtersSchema;
const cursorSchema=z.tuple([z.number().int().min(1).max(4),z.iso.datetime({offset:true}),z.uuid()]);
export function getFilterParams(params:URLSearchParams) {
  return filtersSchema.parse(Object.fromEntries([...params].filter(([key])=>["state","severity","owner","rule","from","to"].includes(key))));
}
function decodeCursor(cursor?:string|null){
  if(!cursor||cursor.length>500) return [null,null,null];
  try{return cursorSchema.parse(JSON.parse(Buffer.from(cursor,"base64url").toString("utf8")));}catch{return [null,null,null];}
}
export async function listExceptions(scope:Scope, filters:z.infer<typeof filtersSchema>={}, cursor?:string|null, limit=20){
  return inScope(scope,async client=>{
    const rows=(await client.query<Occurrence>(`SELECT ${occurrenceColumns} ${occurrenceJoin}
      WHERE o.workspace_id=$1
      AND ($2::text IS NULL OR o.state=$2) AND ($3::text IS NULL OR f.severity=$3)
      AND ($4::text IS NULL OR o.owner_id::text=$4 OR ($4='unassigned' AND o.owner_id IS NULL))
      AND ($5::uuid IS NULL OR r.id=$5) AND ($6::date IS NULL OR o.opened_at >= $6::date) AND ($7::date IS NULL OR o.opened_at < $7::date+1)
      AND ($8::int IS NULL OR (${occurrenceRank},o.opened_at,o.id) < ($8::int,$9::timestamptz,$10::uuid))
      ORDER BY rank DESC,o.opened_at DESC,o.id DESC LIMIT $11`,
      [scope.workspace,filters.state??null,filters.severity??null,filters.owner??null,filters.rule??null,filters.from??null,filters.to??null,...decodeCursor(cursor),limit+1])).rows;
    const page=rows.slice(0,limit),last=page.at(-1);
    return {items:page,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify([last.rank,last.opened_at.toISOString(),last.id])).toString("base64url"):null};
  });
}
export async function workspacePeople(scope:Scope){
  return inScope(scope,async client=>(await client.query<{id:string;name:string;email:string;role:string}>(`SELECT u.id,u.name,u.email,
    CASE WHEN m.role='owner' THEN 'owner' ELSE wm.role END AS role FROM memberships m JOIN users u ON u.id=m.user_id
    LEFT JOIN workspace_memberships wm ON wm.tenant_id=m.tenant_id AND wm.user_id=m.user_id AND wm.workspace_id=$1
    WHERE m.role='owner' OR wm.role IS NOT NULL ORDER BY u.name`,[scope.workspace])).rows);
}
export async function exceptionDetail(scope:Scope,id:string){
  return inScope(scope,async client=>{
    const item=await one<Occurrence>(client,`SELECT ${occurrenceColumns} ${occurrenceJoin} WHERE o.workspace_id=$1 AND o.id=$2`,[scope.workspace,id]);
    if(!item) return missing();
    const history=(await client.query<{name:string;created_at:Date;actor:string|null;details:Record<string,unknown>}>(`
      SELECT a.name,a.created_at,a.details,u.name AS actor FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id
      WHERE a.workspace_id=$1 AND a.target=$2 ORDER BY a.created_at DESC LIMIT 40`,[scope.workspace,id])).rows;
    const evidence=(await client.query<{outcome:string;rule_version:number;observed_at:Date;evidence:Record<string,unknown>}>(`
      SELECT v.outcome,v.rule_version,v.observed_at,v.evidence FROM evaluations v WHERE v.workspace_id=$1 AND v.occurrence_id=$2
      ORDER BY v.observed_at DESC LIMIT 12`,[scope.workspace,id])).rows;
    return {item,history,evidence};
  });
}
export async function dashboard(scope:Scope){
  return inScope(scope,async client=>{
    const counts=await one<SummaryCount>(client,`SELECT
      count(*) FILTER(WHERE o.closed_at IS NULL AND (o.state<>'suppressed' OR o.suppressed_until<=now()))::int AS total,
      count(*) FILTER(WHERE o.closed_at IS NULL AND f.severity='critical' AND o.state<>'suppressed')::int AS critical,
      count(*) FILTER(WHERE o.closed_at IS NULL AND o.owner_id IS NOT NULL)::int AS assigned,
      count(*) FILTER(WHERE o.closed_at>=now()-interval '7 days' AND o.state='resolved')::int AS resolved
      ${occurrenceJoin} WHERE o.workspace_id=$1`,[scope.workspace]);
    const series=(await client.query<{day:string;found:number;resolved:number}>(`SELECT TO_CHAR(d,'Mon DD') AS "day",
      (SELECT COUNT(*)::int FROM occurrences o WHERE o.workspace_id=$1 AND o.opened_at>=d AND o.opened_at<d+interval '1 day') found,
      (SELECT COUNT(*)::int FROM occurrences o WHERE o.workspace_id=$1 AND o.closed_at>=d AND o.closed_at<d+interval '1 day' AND o.state='resolved') resolved
      FROM generate_series(date_trunc('day',now())-interval '6 days',date_trunc('day',now()),interval '1 day') d`,[scope.workspace])).rows;
    const connections=(await client.query<{id:string;provider:string;label:string;host:string;health:string;last_success_at:Date|null;last_error:string|null;settings:Record<string,unknown>}>(`
      SELECT id,provider,label,host,health,last_success_at,last_error,settings FROM connections WHERE workspace_id=$1 ORDER BY provider`,[scope.workspace])).rows;
    const rules=(await client.query<{id:string;name:string;module:string;version:number;enabled:boolean;draft:unknown;coverage:string|null;completed_at:Date|null}>(`
      SELECT r.*,c.state AS coverage,c.completed_at FROM rules r LEFT JOIN checkpoints c ON c.tenant_id=r.tenant_id AND c.rule_id=r.id AND c.source='comparison'
      WHERE r.workspace_id=$1 ORDER BY r.updated_at DESC`,[scope.workspace])).rows;
    const runs=(await client.query<{id:string;name:string|null;rule_id:string|null;kind:string;status:string;created_at:Date;finished_at:Date|null;summary:Record<string,unknown>;error:string|null}>(`
      SELECT x.*,r.name FROM runs x LEFT JOIN rules r ON r.tenant_id=x.tenant_id AND r.id=x.rule_id
      WHERE x.workspace_id=$1 ORDER BY x.created_at DESC LIMIT 25`,[scope.workspace])).rows;
    return {counts,series,connections,rules,runs};
  });
}
export async function reports(scope:Scope){
  return inScope(scope,async client=>{
    const exports=(await client.query<{id:string;status:string;row_count:number|null;created_at:Date;expires_at:Date}>(`SELECT id,status,row_count,created_at,expires_at
      FROM exports WHERE workspace_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 25`,[scope.workspace])).rows;
    const events=(await client.query<{id:string;name:string;target:string|null;created_at:Date;actor:string|null}>(`SELECT a.id,a.name,a.target,a.created_at,u.name AS actor
      FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.workspace_id=$1 ORDER BY a.created_at DESC LIMIT 60`,[scope.workspace])).rows;
    const plan=await one<{plan:string;status:string;active_scope_limit:number;evidence_days:number}>(client,"SELECT plan,status,active_scope_limit,evidence_days FROM entitlements");
    return {exports,events,plan};
  });
}
