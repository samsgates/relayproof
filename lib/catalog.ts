export const modules = [
  {id:"tickets", name:"Ticket reconciliation", group:"Verification", icon:"link", input:"Live ServiceNow and Jira Cloud", description:"Find missing engineering handoffs, duplicate issues, and status drift."},
  {id:"changes", name:"Change evidence", group:"Verification", icon:"git", input:"Live GitHub and ServiceNow or evidence input", description:"Compare production deployments with approved change records."},
  {id:"offboarding", name:"Offboarding verification", group:"Verification", icon:"user", input:"Live Entra and ServiceNow or evidence input", description:"Verify account and application access after a departure."},
  {id:"cmdb", name:"Cloud and CMDB", group:"Verification", icon:"cloud", input:"Live AWS and ServiceNow or evidence input", description:"Compare cloud inventory with ServiceNow configuration items."},
  {id:"sla", name:"SLA intervention", group:"Service delivery", icon:"clock", input:"Live ServiceNow or evidence input", description:"Surface open cases nearing their configured SLA deadlines."},
  {id:"msp", name:"MSP service reporting", group:"Service delivery", icon:"layers", input:"Customer-scoped evidence input", description:"Generate reproducible SLA and incident metrics by customer workspace."},
  {id:"claims", name:"Vendor SLA claims", group:"Service delivery", icon:"file", input:"Reviewed contract terms and incident evidence", description:"Calculate credits and retain links to the supporting contract clauses."},
  {id:"upgrade", name:"Upgrade readiness", group:"Platform quality", icon:"list", input:"ATF and reviewer evidence input", description:"Track critical workflows, testing, and business sign-off."},
  {id:"knowledge", name:"Knowledge effectiveness", group:"Platform quality", icon:"book", input:"Dated request volumes and article evidence", description:"Measure targeted repeat-ticket rates before and after publication."},
] as const;
export type ModuleId=typeof modules[number]["id"];
export const moduleIds=modules.map(module=>module.id) as [ModuleId,...ModuleId[]];
export const providers=["servicenow","jira","github","entra","aws"] as const;
export type Provider=typeof providers[number];
