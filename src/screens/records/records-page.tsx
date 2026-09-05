import { RecordsList } from "../../features/session/records-list";
import { PageShell } from "../page-shell";

export function RecordsPage() {
  return (
    <>
      <PageShell id="records" hideStatus />
      <RecordsList />
    </>
  );
}
