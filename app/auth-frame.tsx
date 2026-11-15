import { Check, Link2, Radio, ShieldCheck } from "lucide-react";
import { Brand } from "./presentation";

export default function AuthFrame({children}:{children:React.ReactNode}){
  return <div className="auth-layout"><section className="auth-showcase">
    <Brand/>
    <div className="auth-showcase-content"><div className="auth-illustration" aria-hidden="true"><div className="orbit one"/><div className="orbit two"/><div className="orbit three"/>
      <span className="orbit-core"><Link2 size={52}/></span><span className="orbit-chip a"><Radio size={20}/></span><span className="orbit-chip b"><Check size={20}/></span><span className="orbit-chip c"><ShieldCheck size={22}/></span></div>
      <h2>Verify every handoff.</h2><p>Trace discrepancies from ServiceNow to the tools your teams use, with evidence and a clear owner.</p>
    </div><small>RelayProof by VisionLab</small>
  </section><main id="main" className="auth-main"><div className="auth-mobile-brand"><Brand/></div><div className="auth-panel">{children}</div></main></div>;
}
