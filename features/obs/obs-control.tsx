"use client";

import { useEffect, useRef, useState } from "react";
import { OBSWebSocket } from "obs-websocket-js";
import {
  configureObs,
  getVirtualCameraStatus,
  retryUntilSuccess,
  startVirtualCamera,
  stopVirtualCamera
} from "./obs-service";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

type ObsControlProps = {
  onStatusChange?: (status: { connected: boolean; virtualCameraActive: boolean }) => void;
};

export function ObsControl({ onStatusChange }: ObsControlProps) {
  const clientRef = useRef<OBSWebSocket | null>(null);
  const passwordRef = useRef("");
  const [url, setUrl] = useState("ws://127.0.0.1:4455");
  const [password, setPassword] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [version, setVersion] = useState("");
  const [virtualCameraActive, setVirtualCameraActive] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("正在检查由启动脚本管理的 OBS…");

  useEffect(() => {
    onStatusChange?.({
      connected: connection === "connected",
      virtualCameraActive
    });
  }, [connection, virtualCameraActive, onStatusChange]);

  useEffect(() => {
    let active = true;
    void fetch("/api/obs/runtime", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("OBS_RUNTIME_UNAVAILABLE");
        return response.json() as Promise<{ managed: boolean; url: string; password: string }>;
      })
      .then(async (runtime) => {
        if (!active) return;
        if (runtime.managed && runtime.password) {
          setUrl(runtime.url);
          const connected = await retryUntilSuccess(
            () => connect(runtime.url, runtime.password, true),
            {
              attempts: 20,
              delayMs: 1_500,
              isCancelled: () => !active,
              onRetry: (attempt) => setMessage(`OBS 正在启动，自动连接重试 ${attempt}/20…`)
            }
          );
          if (active && !connected) {
            setMessage("OBS 在 30 秒内未就绪，请确认它已启动；也可以手动连接。");
          }
          return;
        }
        setMessage("当前 OBS 未由启动器管理。请关闭 OBS 后重新运行 Start-AI-Interviewer.cmd，即可免填密码自动连接。");
      })
      .catch(() => {
        if (active) setMessage("无法读取 OBS 启动状态，请手动连接。");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (connection !== "connected") return;
    const timer = window.setInterval(async () => {
      try {
        const client = clientRef.current;
        if (client) setVirtualCameraActive(await getVirtualCameraStatus(client));
      } catch {
        setConnection("error");
        setMessage("与 OBS 的连接已断开，请重新连接。");
      }
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [connection]);

  useEffect(() => () => {
    void clientRef.current?.disconnect();
    passwordRef.current = "";
  }, []);

  async function connect(
    targetUrl = url,
    targetPassword = password,
    configureAfterConnect = false
  ) {
    setConnection("connecting");
    setMessage(configureAfterConnect ? "正在自动连接并配置 OBS…" : "正在连接 OBS…");
    const client = new OBSWebSocket();
    try {
      const hello = await client.connect(targetUrl, targetPassword || undefined, { rpcVersion: 1 });
      clientRef.current = client;
      passwordRef.current = targetPassword;
      setPassword("");
      setVersion(hello.obsWebSocketVersion);
      setConnection("connected");
      if (configureAfterConnect) {
        const result = await configureObs(client, `${window.location.origin}/stage`);
        setVirtualCameraActive(true);
        setMessage(
          `OBS 已自动就绪：${result.sceneCreated ? "新建" : "更新"}场景、` +
          `${result.inputCreated ? "新建" : "更新"}舞台源，虚拟摄像头已启动。`
        );
      } else {
        setVirtualCameraActive(await getVirtualCameraStatus(client));
        setMessage("OBS 已连接，密码仅保存在当前页面内存中。");
      }
    } catch (cause) {
      void client.disconnect();
      setConnection("error");
      const text = cause instanceof Error ? cause.message : String(cause);
      setMessage(
        /auth|password|4009/i.test(text)
          ? "OBS WebSocket 密码不正确。"
          : "无法连接 OBS。请确认 OBS 已启动、WebSocket 服务器已启用且端口为 4455。"
      );
      return false;
    }
    return true;
  }

  async function disconnect() {
    await clientRef.current?.disconnect();
    clientRef.current = null;
    passwordRef.current = "";
    setConnection("disconnected");
    setVersion("");
    setVirtualCameraActive(false);
    setMessage("已断开 OBS。");
  }

  async function setup() {
    const client = clientRef.current;
    if (!client) return;
    setWorking(true);
    setMessage("正在创建场景并启动虚拟摄像头…");
    try {
      const result = await configureObs(client, `${window.location.origin}/stage`);
      setVirtualCameraActive(true);
      setMessage(
        `OBS 已就绪：${result.sceneCreated ? "新建场景" : "更新场景"}，` +
        `${result.inputCreated ? "新建浏览器源" : "更新浏览器源"}，` +
        `${result.audioMonitoringEnabled ? "舞台音频监听已开启" : "舞台音频待配置"}，虚拟摄像头已启动。`
      );
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setMessage(`OBS 自动配置失败：${text}`);
    } finally {
      setWorking(false);
    }
  }

  async function toggleVirtualCamera() {
    const client = clientRef.current;
    if (!client) return;
    setWorking(true);
    try {
      const next = virtualCameraActive
        ? await stopVirtualCamera(client)
        : await startVirtualCamera(client);
      setVirtualCameraActive(next);
      setMessage(next ? "虚拟摄像头已启动。" : "虚拟摄像头已停止。");
    } catch (cause) {
      setMessage(`虚拟摄像头操作失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setWorking(false);
    }
  }

  const connected = connection === "connected";

  return (
    <article className="card obsControl">
      <div className="cardHeading">
        <h2>OBS 虚拟摄像头</h2>
        <span className={`obsState ${connection}`}>
          {connected ? `已连接 ${version}` : connection === "connecting" ? "连接中" : "未连接"}
        </span>
      </div>

      {!connected && (
        <details className="obsManualConnection">
          <summary>高级手动连接</summary>
          <div className="obsCredentials">
            <label>
              WebSocket 地址
              <input value={url} onChange={(event) => setUrl(event.target.value)} />
            </label>
            <label>
              WebSocket 密码
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="off"
                placeholder="未设置密码可留空"
              />
            </label>
            <button disabled={connection === "connecting"} onClick={() => void connect()}>连接 OBS</button>
          </div>
        </details>
      )}

      {connected && (
        <div className="obsActions">
          <button disabled={working} onClick={setup}>
            {working ? "正在处理…" : "一键配置并输出"}
          </button>
          <button className="secondary" disabled={working} onClick={toggleVirtualCamera}>
            {virtualCameraActive ? "停止虚拟摄像头" : "启动虚拟摄像头"}
          </button>
          <button className="ghost" disabled={working} onClick={disconnect}>断开</button>
        </div>
      )}

      <div className="obsMessage">
        <i className={virtualCameraActive ? "active" : ""} />
        <p>{message}</p>
      </div>
      <p className="muted">会议软件中选择“OBS Virtual Camera”。自动启动密码经 DPAPI 加密后保存在本机 SQLite；高级手动输入的密码只保留在当前页面内存中。</p>
    </article>
  );
}
