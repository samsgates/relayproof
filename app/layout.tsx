import type { Metadata } from "next";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/manrope";
import "./styles.css";

export const metadata:Metadata={title:{default:"RelayProof",template:"%s · RelayProof"},description:"Monitor ServiceNow handoffs and verify operational workflows.",icons:{icon:"/relayproof.svg"}};
export default function Layout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body><a className="skip" href="#main">Skip to main content</a>{children}</body></html>;
}
