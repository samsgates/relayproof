import Link from "next/link";
import { ArrowDownUp, ArrowDownRight, ArrowUpRight, ArrowRight, Bell, BookOpen, ChartNoAxesCombined, Check, CircleAlert, Cloud, FileText, GitPullRequest,
  Layers, ListChecks, Link2, Clock3, Plug, Radio, Settings2, ShieldCheck, UserRoundCheck, Workflow, LayoutDashboard, type LucideIcon } from "lucide-react";
export const iconMap:Record<string,LucideIcon>={link:Link2,git:GitPullRequest,user:UserRoundCheck,cloud:Cloud,clock:Clock3,layers:Layers,file:FileText,list:ListChecks,book:BookOpen,overview:LayoutDashboard,
  exceptions:CircleAlert,rules:Workflow,connections:Plug,modules:Layers,reports:ChartNoAxesCombined,settings:Settings2,radio:Radio,check:Check,shield:ShieldCheck,bell:Bell,sort:ArrowDownUp};
export function Mark(){return <span className="brand-icon"><svg viewBox="0 0 34 34" fill="none" aria-hidden="true"><path d="M8 11h17m-5-5 5 5-5 5m6 7H9m5-5-5 5 5 5" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/></svg></span>}
export function Brand(){return <span className="brand"><Mark/><span>RelayProof<span className="brand-period">.</span></span></span>}
export function Icon({name,size=18}:{name:string;size?:number}){const I=iconMap[name]??CircleAlert;return <I size={size} aria-hidden="true"/>}
export const human=(value:string)=>value.replaceAll("_"," ").replace(/^[a-z]/,v=>v.toUpperCase());
export function Badge({value}:{value:string}){
  const category=["critical","failed","degraded","revoked","fail","expired"].includes(value)?"danger":
    ["high","partial","acknowledged","suppressed","unknown","paused"].includes(value)?"warning":
    ["healthy","active","resolved","succeeded","pass","published"].includes(value)?"positive":
    ["open","running","medium"].includes(value)?"info":"neutral";
  return <span className={"badge "+category}><span aria-hidden="true"/>{human(value)}</span>;
}
export function dateLabel(value:Date|string|null,timezone="UTC",detailed=false){
  if(!value)return "Unavailable";
  return new Intl.DateTimeFormat("en",{month:"short",day:"numeric",...(detailed?{hour:"numeric",minute:"2-digit"}:{}),timeZone:timezone}).format(new Date(value));
}
export function Empty({title,description,icon="check",action}:{title:string;description:string;icon?:string;action?:React.ReactNode}){
  return <div className="empty"><div className="empty-icon"><Icon name={icon} size={23}/></div><strong>{title}</strong><p>{description}</p>{action}</div>;
}
export function PageTitle({title,description,action}:{title:string;description:string;action?:React.ReactNode}){
  return <div className="page-title"><div><h1>{title}</h1><p>{description}</p></div>{action&&<div className="title-action">{action}</div>}</div>;
}
export function SectionTitle({title,description,href}:{title:string;description?:string;href?:string}){
  return <div className="section-title"><div><h2>{title}</h2>{description&&<p>{description}</p>}</div>{href&&<Link className="subtle-link" href={href}>View all <ArrowRight size={15}/></Link>}</div>;
}
export function Evidence({data}:{data:unknown}){
  if(data===null||data===undefined)return <span className="muted">Unavailable</span>;
  if(Array.isArray(data)) return data.length?<div className="evidence-list">{data.map((item,i)=><div key={i}><Evidence data={item}/></div>)}</div>:<span className="muted">None</span>;
  if(typeof data==="object")return <dl className="evidence">{Object.entries(data).map(([key,value])=><div key={key}><dt>{human(key.replace(/([a-z])([A-Z])/g,"$1 $2"))}</dt><dd><Evidence data={value}/></dd></div>)}</dl>;
  if(typeof data==="string"&&/^https:\/\//.test(data))return <a className="subtle-link" href={data} rel="noopener noreferrer" target="_blank">Open source <ArrowUpRight size={14}/></a>;
  if(typeof data==="number")return <span>{Number.isInteger(data)?data.toLocaleString("en-US"):Number(data.toFixed(4)).toLocaleString("en-US")}</span>;
  return <span>{typeof data==="boolean"?data?"Yes":"No":String(data)}</span>;
}
export function Trend({series}:{series:{day:string;found:number;resolved:number}[]}){
  const ceiling=Math.max(4,...series.flatMap(d=>[d.found,d.resolved]));
  const labels=[ceiling,Math.round(ceiling*.75),Math.round(ceiling*.5),Math.round(ceiling*.25),0];
  return <div className="trend" role="img" aria-label={"Last seven days: "+series.map(d=>d.day+" "+d.found+" opened and "+d.resolved+" resolved").join(", ")}>
    <div className="trend-legend"><span><i/> Opened</span><span><i/> Verified fixed</span></div>
    <div className="trend-layout">
      <div className="trend-axis">{labels.map((label,i)=><span key={i}>{label}</span>)}</div>
      <div className="trend-main"><div className="plot">
        <div className="trend-grid">{labels.map((_,i)=><i key={i}/>)}</div>
        {series.map(d=><div className="bar-group" key={d.day} title={d.day+": "+d.found+" opened, "+d.resolved+" fixed"}>
          <span className="bar opened" style={{height:(d.found/ceiling*100)+"%"}}/><span className="bar resolved" style={{height:(d.resolved/ceiling*100)+"%"}}/>
        </div>)}
      </div><div className="trend-days">{series.map(d=><span key={d.day}>{d.day}</span>)}</div></div>
    </div>
  </div>;
}
export function Stat({title,value,icon,help,tone="primary"}:{title:string;value:number;icon:string;help:string;tone?:string}){
  return <article className="stat"><div className="stat-top"><span>{title}</span><span className={"stat-icon "+tone}><Icon name={icon} size={19}/></span></div><strong>{value}</strong><p>{help}</p></article>;
}
export function SmallChange(){return <ArrowDownRight size={16} aria-hidden="true"/>}
