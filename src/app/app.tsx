import { useEffect, useState } from "react";

import { getStartupState, openAppDirectory, restoreDefaultConfig, restoreLastGoodConfig } from "../api/commands";
import type { StartupState } from "../generated/bindings";
import { ConfigRepair } from "../features/config-repair/config-repair";

export function App() {
  const [startup, setStartup] = useState<StartupState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getStartupState().then((result) => {
      if (result.ok) setStartup(result.data);
      else setStartup({ kind: "invalid", error: result.error });
    }).catch(() => {
      setStartup({ kind: "invalid", error: { code: "STARTUP_STATE_UNAVAILABLE", message: "无法读取桌面服务状态", requestId: "local", retryable: false } });
    });
  }, []);

  async function repair(action: typeof restoreDefaultConfig) {
    setBusy(true);
    const result = await action();
    setStartup(result.ok ? result.data : { kind: "invalid", error: result.error });
    setBusy(false);
  }

  if (!startup) {
    return <main className="foundation-shell"><p role="status">正在检查本地配置…</p></main>;
  }
  if (startup.kind === "recoverable" || startup.kind === "invalid") {
    return <ConfigRepair state={startup} busy={busy} onRestoreLastGood={() => void repair(restoreLastGoodConfig)} onRestoreDefaults={() => void repair(restoreDefaultConfig)} onOpenConfig={() => void openAppDirectory("config")} />;
  }
  return (
    <main className="foundation-shell">
      <section className="foundation-card" aria-labelledby="foundation-title">
        <p className="foundation-eyebrow">本地单体迁移</p>
        <h1 id="foundation-title">Tauri Foundation</h1>
        <p className="foundation-status">
          Rust 桌面核心与 React 界面外壳已建立，旧版 Electron 入口暂时保持不变。
        </p>
      </section>
    </main>
  );
}
