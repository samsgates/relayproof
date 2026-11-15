import test from "node:test";
import assert from "node:assert/strict";
import { baseConfig, evaluate, evaluateTickets } from "../lib/rules";
import { example } from "../lib/examples";
import { modules } from "../lib/catalog";
import { approvedHost } from "../lib/providers";
import { seal, unseal } from "../lib/crypto";
import { csvCell } from "../lib/worker";

const config=baseConfig.parse({});
test("all nine modules process validated representative evidence",()=>{
  for(const m of modules){
    const result=evaluate(m.id,example(m.id),config);
    assert.ok(Object.keys(result.report).length,m.id);
  }
});
test("ticket rules identify missing targets and deduplicate issue IDs",()=>{
  const sample=example("tickets") as ReturnType<typeof Object>;
  sample.issues.push(sample.issues[0]);
  const r=evaluateTickets(sample,config,new Date());
  assert.deepEqual(r.findings.filter(x=>x.outcome==="fail").map(x=>x.kind),["missing","duplicate"]);
  assert.equal(r.findings.find(x=>x.kind==="missing")?.confirmations,2);
});
test("degraded scope and first-seen timestamps produce unknown evidence",()=>{
  const sample=example("tickets") as ReturnType<typeof Object>;
  assert.ok(evaluateTickets({...sample,coverage:false},config,new Date()).findings.every(x=>x.outcome==="unknown"));
  delete sample.incidents[0].eligibleAt;
  assert.equal(evaluateTickets(sample,config,new Date()).findings.find(x=>x.subject==="inc-a"&&x.kind==="missing")?.outcome,"unknown");
});
test("contract credits honor the review requirement, precision and cap",()=>{
  const sample=example("claims") as ReturnType<typeof Object>;
  const output=evaluate("claims",{...sample,capMinor:11},config);
  assert.equal(output.report.claimMinor,11);
  assert.throws(()=>evaluate("claims",{...sample,termsApproved:false},config));
});
test("export fields and credentials are safe by construction",()=>{
  process.env.RELAY_ENCRYPTION_KEY=Buffer.alloc(32,1).toString("base64");
  const encoded=seal({secret:"provider-secret"},"tenant-one");
  assert.deepEqual(unseal(encoded,"tenant-one"),{secret:"provider-secret"});
  assert.throws(()=>unseal(encoded,"tenant-two"));
  assert.equal(csvCell("=HYPERLINK(\"bad\")"), "\"'=HYPERLINK(\"\"bad\"\")\"");
  assert.throws(()=>approvedHost("servicenow","https://x.service-now.com@elsewhere.com"));
  assert.throws(()=>approvedHost("servicenow","https://x.service-now.com.example.org"));
  assert.equal(approvedHost("servicenow","https://demo.service-now.com"),"https://demo.service-now.com");
});
