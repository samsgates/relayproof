import Link from "next/link";
import AuthFrame from "./auth-frame";
export default function NotFound(){return <AuthFrame><h1>Page unavailable</h1><p>Check the address or return to your workspace.</p><Link href="/" className="button primary">Open RelayProof</Link></AuthFrame>;}
