import { routeCapabilities, routeDesignRef, routeLabel, type RouteId } from "../app/routes";

export interface PageShellProps {
  id: RouteId;
  hideStatus?: boolean;
}

export function PageShell({ id, hideStatus }: PageShellProps) {
  const label = routeLabel(id);
  const designRef = routeDesignRef(id);
  const capabilities = routeCapabilities(id);
  const headingId = `page-heading-${id}`;

  return (
    <section className="page-placeholder" role="region" aria-labelledby={headingId}>
      <p className="page-eyebrow">Design §{designRef}</p>
      <h1 id={headingId}>{label}</h1>
      <ul className="page-capabilities">
        {capabilities.map((cap) => (
          <li key={cap}>{cap}</li>
        ))}
      </ul>
      {!hideStatus && <p className="page-status">本页面尚未接入业务逻辑；当前为 Tauri 壳层。</p>}
    </section>
  );
}
