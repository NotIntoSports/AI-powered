"use client";

import { useEffect, useMemo, useState } from "react";
import type { InterviewReadinessItem } from "../readiness/interview-readiness";
import {
  getNetworkQuality,
  networkStatus,
  subscribeNetworkQuality
} from "../rtc/network-quality";

type ToastItem = {
  key: string;
  title: string;
  detail: string;
  href: string;
  hrefLabel: string;
};

type IntegrationAlertsProps = {
  missing?: InterviewReadinessItem[];
};

function settingsHrefForItem(id: string) {
  if (
    id.includes("virtual") ||
    id.includes("obs") ||
    id.includes("camera") ||
    id.includes("meeting") ||
    id.includes("speech") ||
    id.includes("stage") ||
    id.includes("media")
  ) {
    return "/settings?focus=virtual";
  }
  return "/settings";
}

/**
 * Floating failure toasts only — never occupy the workspace layout.
 */
export function IntegrationAlerts({ missing = [] }: IntegrationAlertsProps) {
  const [network, setNetwork] = useState(getNetworkQuality);
  const [dismissed, setDismissed] = useState<Record<string, true>>({});

  useEffect(() => subscribeNetworkQuality(() => setNetwork(getNetworkQuality())), []);

  const alerts = useMemo(() => {
    const next: ToastItem[] = [];
    if (missing.length > 0) {
      next.push({
        key: "readiness",
        title: `开始前还需完成 ${missing.length} 项设置`,
        detail: missing.slice(0, 3).map((item) => item.label).join("、"),
        href: settingsHrefForItem(missing[0]?.id || ""),
        hrefLabel: "前往设置"
      });
    }
    if (!network.managementReachable) {
      next.push({
        key: "mgmt",
        title: "管理端未接通",
        detail: "登录与模型同步可能失败，请到设置检查连接。",
        href: "/settings",
        hrefLabel: "前往设置"
      });
    }
    if (network.rtcConnected && networkStatus(network) === "warn") {
      next.push({
        key: "rtc",
        title: "会议音频桥接网络较差",
        detail: "实时字幕可能延迟或丢包。",
        href: "/settings#settings-rtc-bridge",
        hrefLabel: "查看桥接"
      });
    }
    return next;
  }, [missing, network]);

  useEffect(() => {
    const active = new Set(alerts.map((item) => item.key));
    setDismissed((current) => {
      let changed = false;
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (!active.has(key)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [alerts]);

  const visible = alerts.filter((item) => !dismissed[item.key]);
  if (visible.length === 0) return null;

  return (
    <aside className="workspaceToasts" aria-live="polite" aria-label="接入异常提示">
      {visible.map((alert) => (
        <div className="workspaceToast" key={alert.key} role="status">
          <div className="workspaceToastBody">
            <strong>{alert.title}</strong>
            <span>{alert.detail}</span>
            <a className="textLink" href={alert.href}>
              {alert.hrefLabel} →
            </a>
          </div>
          <button
            type="button"
            className="ghost workspaceToastClose"
            aria-label={`关闭：${alert.title}`}
            onClick={() => setDismissed((current) => ({ ...current, [alert.key]: true }))}
          >
            关闭
          </button>
        </div>
      ))}
    </aside>
  );
}
