import { MaterialsLibrary } from "../../features/materials/materials-library";
import { PageShell } from "../page-shell";

export function MaterialsPage() {
  return (
    <>
      <PageShell id="materials" hideStatus />
      <MaterialsLibrary />
    </>
  );
}
