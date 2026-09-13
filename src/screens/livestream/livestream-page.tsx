import { LivestreamStudio } from "../../features/livestream/livestream-studio";
import { PageShell } from "../page-shell";

export function LivestreamPage() {
  return <>
    <PageShell id="livestream" />
    <LivestreamStudio />
  </>;
}
