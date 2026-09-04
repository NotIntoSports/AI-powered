import type { PublicError, StartupState } from "../../generated/bindings";

type RepairProps = {
  state: Extract<StartupState, { kind: "recoverable" | "invalid" }>;
  busy: boolean;
  onRestoreLastGood: () => void;
  onRestoreDefaults: () => void;
  onOpenConfig: () => void;
};

export function ConfigRepair({ state, busy, onRestoreLastGood, onRestoreDefaults, onOpenConfig }: RepairProps) {
  const error: PublicError = state.error;
  return (
    <main className="foundation-shell">
      <section className="foundation-card repair-card" aria-labelledby="repair-title">
        <p className="foundation-eyebrow">安全修复模式</p>
        <h1 id="repair-title">客户端配置需要处理</h1>
        <dl className="repair-error">
          <div><dt>错误代码</dt><dd>{error.code}</dd></div>
          {error.field ? <div><dt>字段</dt><dd>{error.field}</dd></div> : null}
          <div><dt>说明</dt><dd>{error.message}</dd></div>
        </dl>
        <div className="repair-actions">
          {state.kind === "recoverable" ? (
            <button type="button" disabled={busy} onClick={onRestoreLastGood}>恢复上次可用配置</button>
          ) : null}
          <button type="button" disabled={busy} onClick={onRestoreDefaults}>恢复默认配置</button>
          <button type="button" disabled title="安全文件选择器将在权限收紧任务接入">导入配置</button>
          <button type="button" disabled={busy} onClick={onOpenConfig}>打开配置文件</button>
        </div>
      </section>
    </main>
  );
}
