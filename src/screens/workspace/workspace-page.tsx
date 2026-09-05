import { WorkspaceSession } from "../../features/session/workspace-session";
import { PageShell } from "../page-shell";

export function WorkspacePage() {
  return (
    <>
      <PageShell id="workspace" hideStatus />
      <WorkspaceSession />
    </>
  );
}
