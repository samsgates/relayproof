import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronRight, Download, Plus } from "lucide-react";
import { currentUser, findScopes, uuidPattern, type Scope } from "@/lib/auth";
import { modules, type ModuleId } from "@/lib/catalog";
import { dashboard, exceptionDetail, listExceptions, reports, validFilters, workspacePeople, type Occurrence } from "@/lib/read-model";
import { HttpError } from "@/lib/auth";
import { Badge, dateLabel, Empty, Evidence, human, Icon, PageTitle, SectionTitle, Stat, Trend } from "@/app/presentation";
import { Command, ConnectionForm, DeletionForm, EvidenceForm, ExceptionForm, Filter, InviteForm, RuleForm, SettingsForm, Shell, WorkspaceForm } from "@/app/ui";

export const dynamic="force-dynamic";
type Search=Record<string,string|string[]|undefined>;
type Props={params:Promise<{workspace:string;view?:string[]}>;searchParams:Promise<Search>};
type Dash=Awaited<ReturnType<typeof dashboard>>;
const canManage=(scope:Scope)=>["owner","admin"].includes(scope.role);
const canOperate=(scope:Scope)=>["owner","admin","operator"].includes(scope.role);
const canAudit=(scope:Scope)=>["owner","admin","auditor"].includes(scope.role);
const pathFor=(scope:Scope)=>"/w/"+scope.workspace;
const apiFor=(scope:Scope)=>"/api/v1/workspaces/"+scope.workspace;
const providerNames:Record<string,string>={servicenow:"ServiceNow",jira:"Jira Cloud",github:"GitHub",entra:"Microsoft Entra",aws:"AWS"};
const providerInitial:Record<string,string>={servicenow:"SN",jira:"J",github:"GH",entra:"E",aws:"AWS"};

function ExceptionRows({items,path,timezone}:{items:Occurrence[];path:string;timezone:string}){
  if(!items.length)return <Empty title="No exceptions in this view" description="Confirm coverage on the Connections page or adjust your filters." icon="exceptions"/>;
  return <div className="scroll-table exception-table"><table><thead><tr><th scope="col">Exception</th><th scope="col">Severity</th><th scope="col">Status</th><th scope="col">Owner</th><th scope="col">Detected</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
    <tbody>{items.map(item=><tr key={item.id}><td><Link className="record" href={path+"/exceptions/"+item.id}><span className={"record-icon "+item.severity}><Icon name="exceptions" size={17}/></span><span><strong>{item.title}</strong><small>{item.subject} · {item.rule}</small></span></Link></td>
      <td><Badge value={item.severity}/></td><td><Badge value={item.state}/></td><td className="exception-owner">{item.owner??"Unassigned"}</td><td className="exception-date">{dateLabel(item.opened_at,timezone)}</td>
      <td><Link className="icon-button" aria-label={"Open "+item.title+" "+item.subject} href={path+"/exceptions/"+item.id}><ChevronRight size={18}/></Link></td></tr>)}</tbody>
  </table></div>;
}
function ConnectionList({data,scope,actions=false}:{data:Dash;scope:Scope;actions?:boolean}){
  if(!data.connections.length)return <Empty title="No connections yet" description="Add and test a source to start seeing freshness and coverage." icon="connections"
    action={!actions&&<Link href={pathFor(scope)+"/connections"} className="button secondary">Set up connections <ArrowRight size={16}/></Link>}/>;
  return <div className="connection-list">{data.connections.map(con=><div key={con.id} className="connection-row">
    <span className={"provider-logo "+con.provider}>{providerInitial[con.provider]??"?"}</span><div className="connection-info"><strong>{providerNames[con.provider]??con.label}</strong>
      <small>{con.settings.synthetic===true?"Demo connection":con.last_success_at?"Last verified "+dateLabel(con.last_success_at,scope.timezone,true):con.host}</small>
      {con.last_error&&<small className="inline-error">{human(con.last_error)}</small>}</div><Badge value={con.health}/>
      {actions&&canManage(scope)&&con.health!=="revoked"&&<div className="connection-actions">
        <Command endpoint={apiFor(scope)+"/connections/"+con.id+"/test"} label="Test"/>
        <Command endpoint={apiFor(scope)+"/connections/"+con.id+"/revoke"} label="Disconnect" kind="quiet" confirm="Disconnect this source and remove its saved credential?"/></div>}
  </div>)}</div>;
}
async function Overview({data,scope}:{data:Dash;scope:Scope}){
  const path=pathFor(scope), {items}=await listExceptions(scope,{},null,6);
  const last=data.connections.flatMap(c=>c.last_success_at?[c.last_success_at.getTime()]:[]).sort((a,b)=>b-a)[0];
  const coverageIssue=data.connections.some(c=>c.health==="degraded"||c.health==="revoked");
  const liveRules=data.rules.filter(r=>r.enabled&&(r.draft as {source?:string})?.source==="live");
  const delayed=liveRules.some(r=>r.coverage!=="healthy"||!r.completed_at||Date.now()-r.completed_at.getTime()>Math.max(15,(r.draft as {intervalMinutes?:number}).intervalMinutes??5)*60_000);
  return <><PageTitle title="Operations overview" description="Monitor cross-system handoffs, check evidence, and act on exceptions." action={canManage(scope)&&<Link className="button primary" href={path+"/rules/new"}><Plus size={17}/> New rule</Link>}/>
    <div className={"coverage-banner "+(coverageIssue||delayed?"attention":"")}><div className="coverage-icon"><Icon name="radio" size={21}/></div>
      <div><strong>{scope.state==="paused"?"Monitoring is paused":!data.connections.length?"Connect your operational systems":coverageIssue||delayed?"Some coverage needs attention":"Connection and coverage overview"}</strong>
      <p>{last?"Last successful connection check "+dateLabel(new Date(last),scope.timezone,true)+".":"Test connections and activate a rule to establish coverage."}</p></div>
      <Link href={path+"/connections"} className="subtle-link">Review connections <ArrowRight size={16}/></Link></div>
    <div className="stats"><Stat title="Open exceptions" value={data.counts?.total??0} icon="exceptions" help="Across active rules" tone="primary"/>
      <Stat title="Critical exceptions" value={data.counts?.critical??0} icon="bell" help="Highest severity" tone="rose"/>
      <Stat title="Assigned exceptions" value={data.counts?.assigned??0} icon="user" help="With an accountable owner" tone="blue"/>
      <Stat title="Verified fixed" value={data.counts?.resolved??0} icon="check" help="In the last seven days" tone="green"/></div>
    <div className="overview-grid"><section className="panel"><SectionTitle title="Exception activity" description="Opened and verified fixed over the last seven days"/>
      <Trend series={data.series}/></section><section className="panel"><SectionTitle title="Connections" description="Source health and recent verification" href={path+"/connections"}/>
      <ConnectionList data={data} scope={scope}/></section></div>
    <section className="panel table-panel"><SectionTitle title="Recent exceptions" description="Prioritized by severity and detection time" href={path+"/exceptions"}/><ExceptionRows items={items} path={path} timezone={scope.timezone}/></section>
  </>;
}
function Runs({scope,data,full=false}:{scope:Scope;data:Dash;full?:boolean}){
  if(!data.runs.length)return <Empty title="No run history" description="Run a connection test or publish and run a rule." icon="clock"/>;
  return <div className="run-list">{(full?data.runs:data.runs.slice(0,8)).map(run=><details className="run" key={run.id}><summary><div><strong>{run.name??human(run.kind)+" test"}</strong>
    <small>{human(run.kind)} · {dateLabel(run.created_at,scope.timezone,true)}</small></div><Badge value={run.status}/></summary>
    <div className="run-detail">{run.error&&<p className="inline-error">{human(run.error)}</p>}<Evidence data={run.summary}/>{canAudit(scope)&&run.status==="succeeded"&&<a href={apiFor(scope)+"/runs/"+run.id+"/download"} className="subtle-link">Download run report <Download size={14}/></a>}</div></details>)}</div>;
}
async function Section({scope,data,view,sub,query}:{scope:Scope;data:Dash;view:string;sub?:string;query:Search}){
  const path=pathFor(scope),base=apiFor(scope);
  if(view==="overview")return <Overview scope={scope} data={data}/>;
  if(view==="exceptions"&&sub){
    if(!uuidPattern.test(sub))notFound();
    const detail=await exceptionDetail(scope,sub).catch(e=>{if(e instanceof HttpError&&e.status===404)notFound();throw e;});
    const {item,evidence,history}=detail,owners=canOperate(scope)?(await workspacePeople(scope)).filter(x=>["owner","admin","operator"].includes(x.role)):[],latest=evidence[0];
    return <><Link className="subtle-link back" href={path+"/exceptions"}><ArrowLeft size={16}/> Exceptions</Link>
      <PageTitle title={item.title} description={item.subject+" · "+item.rule} action={<div className="badge-row"><Badge value={item.severity}/><Badge value={item.state}/></div>}/>
      <div className="detail-grid"><section className="panel"><SectionTitle title="Comparison evidence" description={latest?"Observed "+dateLabel(latest.observed_at,scope.timezone,true)+" · Rule version "+latest.rule_version:"Observation unavailable"}/>
        {latest?<><Badge value={latest.outcome}/><Evidence data={latest.evidence}/></>:<Empty title="No retained evidence" description="Evidence may have expired under this workspace’s retention settings."/>}
      </section><div className="panel-stack"><section className="panel"><SectionTitle title="Ownership" description={item.owner?"Assigned to "+item.owner:"Unassigned"}/>
        {canOperate(scope)&&<ExceptionForm key={item.version} endpoint={base+"/exceptions/"+item.id} version={item.version} closed={Boolean(item.closed_at)} owners={owners}/>}</section>
        <section className="panel"><SectionTitle title="Activity"/><ol className="timelines">{history.map((event,index)=><li key={index}><strong>{human(event.name.split(".").at(-1)??event.name)}</strong>
          <small>{event.actor??"RelayProof"} · {dateLabel(event.created_at,scope.timezone,true)}</small>{typeof event.details.note==="string"&&<p>{event.details.note}</p>}</li>)}</ol></section></div></div></>;
  }
  if(view==="exceptions"){
    const p=validFilters.safeParse(Object.fromEntries(Object.entries(query).filter(([,v])=>typeof v==="string"&&v)));
    const filters=p.success?p.data:{};
    const cursor=typeof query.cursor==="string"?query.cursor:undefined;
    const results=await listExceptions(scope,filters,cursor);
    const next=results.nextCursor?path+"/exceptions?"+new URLSearchParams({...filters,cursor:results.nextCursor}):undefined;
    return <><PageTitle title="Exception inbox" description="Review discrepancies, assign an owner, and record how each issue was handled." action={canAudit(scope)&&<Command endpoint={base+"/exports"} label="Queue CSV export" body={{state:filters.state,severity:filters.severity}}/>}/>
      <section className="panel table-panel"><Filter href={path+"/exceptions"} filters={filters} rules={data.rules} people={canOperate(scope)?await workspacePeople(scope):[]}/><ExceptionRows items={results.items} path={path} timezone={scope.timezone}/>
      {next&&<div className="table-footer"><Link className="subtle-link" href={next}>Next page <ArrowRight size={16}/></Link></div>}</section></>;
  }
  if(view==="connections")return <><PageTitle title="Connections" description="Configure read-only sources and verify what RelayProof can access."/>
    <div className="detail-grid"><section className="panel"><SectionTitle title="Configured providers"/><ConnectionList data={data} scope={scope} actions/></section>
      {canManage(scope)&&<section className="panel"><SectionTitle title="Add or replace a connection" description="Saving a provider replaces its credentials in this workspace."/><ConnectionForm base={base} oauth={Boolean(process.env.JIRA_CLIENT_ID&&process.env.JIRA_CLIENT_SECRET)}/></section>}</div>
    <section className="panel"><SectionTitle title="Recent checks"/><Runs scope={scope} data={data}/></section></>;
  if(view==="rules"&&sub==="new"){
    if(!canManage(scope))notFound();
    const m=modules.find(item=>item.id===query.module);
    return <><Link className="subtle-link back" href={path+"/rules"}><ArrowLeft size={16}/> Rules</Link><PageTitle title="New rule" description="Choose a module, specify its inputs, and save a draft for review."/>
      <div className="panel form-width"><RuleForm base={base} defaultModule={m?.id} owners={(await workspacePeople(scope)).filter(x=>["owner","admin","operator"].includes(x.role))}/></div></>;
  }
  if(view==="rules"&&sub){
    const rule=data.rules.find(x=>x.id===sub);
    if(!rule)notFound();
    const module=modules.find(m=>m.id===rule.module);
    const runs={...data,runs:data.runs.filter(item=>item.rule_id===rule.id)};
    return <><Link className="subtle-link back" href={path+"/rules"}><ArrowLeft size={16}/> Rules</Link>
      <PageTitle title={rule.name} description={(module?.name??rule.module)+" · "+(rule.version?"Published version "+rule.version:"Draft")} action={<Badge value={rule.enabled?"published":rule.version?"paused":"draft"}/>}/>
      {canManage(scope)&&<div className="detail-grid"><section className="panel"><SectionTitle title="Rule configuration"/><RuleForm base={base} rule={rule} owners={(await workspacePeople(scope)).filter(x=>["owner","admin","operator"].includes(x.role))}/>
       <div className="form-actions rule-actions"><Command endpoint={base+"/rules/"+sub+"/publish"} label="Publish version" kind="primary"/>
        {rule.enabled&&<><Command endpoint={base+"/rules/"+sub+"/pause"} label="Pause rule"/><Command endpoint={base+"/runs"} body={{ruleId:sub,kind:"evaluate"}} label="Run now"/>
          <Command endpoint={base+"/runs"} body={{ruleId:sub,kind:"baseline"}} label="Run baseline"/></>}</div></section>
       <section className="panel"><SectionTitle title="Evidence and preview" description="Upload scope-approved evidence or check how the draft handles a sample."/><EvidenceForm base={base} rule={sub} module={rule.module as ModuleId}/></section></div>}
      <section className="panel"><SectionTitle title="Rule runs"/><Runs scope={scope} data={runs} full/></section></>;
  }
  if(view==="rules")return <><PageTitle title="Monitoring rules" description="Define what should happen, which records to check, and when to raise an exception."
    action={canManage(scope)&&<Link className="button primary" href={path+"/rules/new"}><Plus size={17}/> New rule</Link>}/>
    <section className="panel table-panel">{data.rules.length?<div className="scroll-table"><table><thead><tr><th>Rule</th><th>Module</th><th>Version</th><th>State</th><th>Last covered</th></tr></thead>
      <tbody>{data.rules.map(rule=><tr key={rule.id}><td><Link className="record" href={path+"/rules/"+rule.id}><span className="record-icon"><Icon name="rules" size={17}/></span><strong>{rule.name}</strong></Link></td>
        <td>{modules.find(x=>x.id===rule.module)?.name}</td><td>{rule.version||"Unavailable"}</td><td><Badge value={rule.enabled?"published":rule.version?"paused":"draft"}/></td>
        <td>{dateLabel(rule.completed_at,scope.timezone,true)}</td></tr>)}</tbody></table></div>:<Empty title="No monitoring rules" description="Create a rule using a live connection or reviewed evidence." icon="rules"/>}</section>
    <section className="panel"><SectionTitle title="Recent runs"/><Runs scope={scope} data={data}/></section></>;
  if(view==="modules")return <><PageTitle title="Modules" description="Choose what to verify across your operations."/>
    {[...new Set(modules.map(m=>m.group))].map(group=><section key={group} className="module-section"><SectionTitle title={group}/>
      <div className="module-grid">{modules.filter(m=>m.group===group).map(m=><article className="panel module-card" key={m.id}><span className="module-icon"><Icon name={m.icon} size={21}/></span>
        <h3>{m.name}</h3><p>{m.description}</p><small>{m.input}</small>{canManage(scope)&&<Link className="subtle-link" href={path+"/rules/new?module="+m.id}>Configure module <ArrowRight size={16}/></Link>}</article>)}</div></section>)}</>;
  if(view==="reports"){
    const read=canAudit(scope)?await reports(scope):undefined;
    return <><PageTitle title="Reports and audit" description="Review completed runs, evidence exports, and workspace activity." action={canAudit(scope)&&<Command endpoint={base+"/exports"} label="Queue CSV export"/>}/>
      <section className="panel"><SectionTitle title="Run results"/><Runs scope={scope} data={data} full/></section>
      {read&&<div className="detail-grid"><section className="panel"><SectionTitle title="Evidence exports" description="Download within seven days of generation."/>
        {read.exports.length?<ul className="plain-list">{read.exports.map(item=><li key={item.id}><div><strong>Exception export</strong><small>{dateLabel(item.created_at,scope.timezone,true)} · {item.row_count??0} rows</small></div><Badge value={item.status}/>
          {item.status==="succeeded"&&<a className="icon-button" href={base+"/exports/"+item.id} aria-label="Download CSV"><Download size={18}/></a>}
          {item.status==="succeeded"&&<Command endpoint={base+"/exports/"+item.id+"/revoke"} label="Revoke" kind="quiet" confirm="Revoke this export so it can no longer be downloaded?"/>}</li>)}</ul>:<Empty title="No exports yet" description="Queue an export and refresh to see when it is ready." icon="file"/>}</section>
        <section className="panel"><SectionTitle title="Audit trail"/><ul className="plain-list">{read.events.map(item=><li key={item.id}><div><strong>{human(item.name.replace("."," "))}</strong>
          <small>{item.actor??"RelayProof"} · {dateLabel(item.created_at,scope.timezone,true)}</small></div></li>)}</ul></section></div>}</>;
  }
  if(view==="settings"){
    const people=canManage(scope)?await workspacePeople(scope):[];
    const plan=canAudit(scope)?(await reports(scope)).plan:undefined;
    return <><PageTitle title="Workspace settings" description="Manage monitoring state, alerts, and workspace access."/>
      <div className="detail-grid"><section className="panel"><SectionTitle title="General"/>
        {canManage(scope)?<SettingsForm base={base} name={scope.name} timezone={scope.timezone} state={scope.state} alertEmails={scope.alert_emails}/>:
          <Evidence data={{workspace:scope.name,timezone:scope.timezone,state:scope.state,role:scope.role}}/>}</section>
      {canManage(scope)&&<section className="panel"><SectionTitle title="Invite a teammate" description="Send the private invitation link to the intended recipient."/><InviteForm base={base}/></section>}</div>
      {canManage(scope)&&<section className="panel"><SectionTitle title="Members"/><ul className="plain-list">{people.map(person=><li key={person.id}><div><strong>{person.name}</strong><small>{person.email}</small></div><Badge value={person.role}/>
      {scope.role==="owner"&&person.role!=="owner"&&<Command endpoint={base+"/members/"+person.id} body={{role:null}} label="Revoke access" kind="quiet" confirm="Remove this member’s access to this workspace?"/>}</li>)}</ul></section>}
      {scope.role==="owner"&&<section className="panel form-width"><SectionTitle title="Add a workspace"/><WorkspaceForm base={base}/></section>}
      {plan&&<section className="panel form-width"><SectionTitle title="Subscription and retention"/><Evidence data={plan}/></section>}
      {scope.role==="owner"&&<section className="panel form-width"><SectionTitle title="Organization deletion" description="Request deletion and pause all workspace monitoring for review."/><DeletionForm base={base} organization={scope.organization}/></section>}</>;
  }
  return <><PageTitle title="Setup guide" description="Prepare a new workspace for a customer pilot."/><section className="panel form-width"><ol className="guide">
    <li><strong>Connect ServiceNow and Jira Cloud.</strong><p>Choose approved read-only identities and sample records that demonstrate the expected handoff.</p><Link href={path+"/connections"} className="subtle-link">Open connections <ArrowUpRight size={15}/></Link></li>
    <li><strong>Define which incidents must reach engineering.</strong><p>Configure the assignment group, priority, project, exact correlation field, allowed status pairs, and grace period.</p><Link href={path+"/rules"} className="subtle-link">Open rules <ArrowUpRight size={15}/></Link></li>
    <li><strong>Check a baseline and activate monitoring.</strong><p>Review the run’s coverage and results with the customer, then set the workspace status to Active.</p><Link href={path+"/settings"} className="subtle-link">Open settings <ArrowUpRight size={15}/></Link></li>
  </ol></section></>;
}
export default async function WorkspacePage({params,searchParams}:Props){
  const {workspace,view=[]}=await params;
  if(!uuidPattern.test(workspace))notFound();
  const user=await currentUser();
  if(!user)redirect("/login");
  const scopes=await findScopes(user),scope=scopes.find(item=>item.workspace===workspace);
  if(!scope)notFound();
  const [active="overview",sub]=view;
  if(!["overview","exceptions","rules","connections","modules","reports","settings","help"].includes(active)||view.length>2||(sub&&!["exceptions","rules"].includes(active)))notFound();
  const data=await dashboard(scope);
  return <Shell active={active} workspace={workspace} name={scope.name} organization={scope.organization} username={user.name} role={human(scope.role)}
    scopes={scopes.map(({workspace,name,organization})=>({workspace,name,organization}))}><Section scope={scope} data={data} view={active} sub={sub} query={await searchParams}/></Shell>;
}
