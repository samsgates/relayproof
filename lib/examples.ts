import type { ModuleId } from "./catalog";

const timestamp=(minutes:number)=>new Date(Date.now()+minutes*60_000).toISOString();
export function example(module:ModuleId):unknown {
  switch(module){
    case "tickets":return {coverage:true,statusMap:{"2":["3"],"6":["5"]},
      incidents:[
        {id:"inc-a",number:"INC001045",correlation:"INC001045",state:"2",priority:"1",eligibleAt:timestamp(-120),createdAt:timestamp(-130),updatedAt:timestamp(-110)},
        {id:"inc-b",number:"INC001046",correlation:"INC001046",state:"2",priority:"2",eligibleAt:timestamp(-90),createdAt:timestamp(-100),updatedAt:timestamp(-40)},
      ],
      issues:[
        {id:"2001",key:"OPS-218",status:"3",correlation:"INC001046",updatedAt:timestamp(-50)},
        {id:"2002",key:"OPS-219",status:"3",correlation:"INC001046",updatedAt:timestamp(-41)},
      ]};
    case "changes":return {complete:true,deployments:[{id:"DEP-42",name:"Payments production",time:timestamp(-80),changeId:"CHG-810"}],
      approvals:[{id:"CHG-810",approved:true,time:timestamp(-90)}]};
    case "offboarding":return {exits:[{id:"TASK-114",dueAt:timestamp(-75),completed:true,accountEnabled:true,remainingApps:["Engineering app"]}]};
    case "cmdb":return {complete:true,cloud:[{id:"i-0843",state:"active",owner:"Platform"},{id:"i-0972",state:"active",owner:"Payments"}],
      cmdb:[{id:"CI-200",resourceId:"i-0843",owner:"Platform",state:"active"}]};
    case "sla":return {minutes:60,tasks:[{id:"SLA-202",deadline:timestamp(22),paused:false,closed:false,owner:"Service desk"}]};
    case "msp":return {period:"Monthly reporting sample",tickets:[
      {id:"INC-90",eligible:true,breached:false,closed:true,resolutionMinutes:32},
      {id:"INC-91",eligible:true,breached:true,closed:true,resolutionMinutes:94},
      {id:"INC-92",eligible:false,breached:false,closed:false}]};
    case "claims":return {period:"Monthly credit review",currency:"INR",feeMinor:10000000,capMinor:1500000,claimDeadline:timestamp(14400),
      termsApproved:true,terms:[{id:"uptime",description:"Priority incident restoration",page:8,thresholdSeconds:7200,creditBasisPoints:500}],
      incidents:[{id:"INC-171",termId:"uptime",measuredSeconds:9900,excluded:false}]};
    case "upgrade":return {release:"Platform upgrade",flows:[
      {id:"flow-1",name:"Catalog request approval",owner:"Service Desk",test:"fail",signedOff:false},
      {id:"flow-2",name:"Incident creation",owner:"IT Operations",test:"pass",signedOff:true,reviewer:"Platform Lead"}]};
    case "knowledge":return {category:"VPN setup",publishedAt:timestamp(-43200),article:{name:"Set up corporate VPN"},articleViews:214,
      before:{total:800,repeat:83,days:30},after:{total:900,repeat:51,days:30},notes:"Review seasonality and changes to the request mix."};
  }
}
export const liveExamples={
  tickets:{groupId:"0123456789abcdef0123456789abcdef",projectId:"10001",projectKey:"OPS",jiraField:"customfield_10001",
    sourceField:"sys_id",includedPriorities:["1","2"],statusMap:{"1":["10000"],"2":["10001"],"6":["10002"]},lookbackDays:30,maxRecords:1500},
  changes:{repository:"company/application",environment:"production",changeField:"u_pipeline_change_id",approvalTimeField:"u_approved_at"},
  offboarding:{identityField:"u_entra_id",dueField:"u_exit_due_at",groupId:"0123456789abcdef0123456789abcdef",appResourceIds:[]},
  cmdb:{region:"ap-south-1",className:"cmdb_ci_server",resourceField:"u_cloud_id",ownerTag:"Owner",scopeField:"u_cloud_source",scopeValue:"aws"},
  sla:{minutes:60,slaId:"0123456789abcdef0123456789abcdef"},
} as const;
