"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { findObsVirtualCamera, stopMediaStream } from "./virtual-camera-device";

type CheckState = "idle" | "checking" | "ready" | "missing" | "error";

type VirtualCameraPreviewProps = {
  active?: boolean;
  onVerifiedChange?: (verified: boolean) => void;
};

const VERIFICATION_TTL_MS = 5 * 60_000;

export function VirtualCameraPreview({
  active,
  onVerifiedChange
}: VirtualCameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const verifiedRef = useRef(false);
  const expiryTimerRef = useRef<number | null>(null);
  const checkGenerationRef = useRef(0);
  const [state, setState] = useState<CheckState>("idle");
  const [verified, setVerified] = useState(false);
  const [message, setMessage] = useState(
    "启动 OBS Virtual Camera 后，在这里验证会议软件能够看到的最终画面。"
  );

  function clearExpiryTimer() {
    if (expiryTimerRef.current !== null) {
      window.clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
  }

  const invalidateVerification = useCallback((nextMessage: string) => {
    checkGenerationRef.current += 1;
    clearExpiryTimer();
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    verifiedRef.current = false;
    setVerified(false);
    setState("idle");
    setMessage(nextMessage);
  }, []);

  function stopPreview(nextMessage = "画面已验证，预览已停止且摄像头设备已释放。") {
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState(verified ? "ready" : "idle");
    setMessage(nextMessage);
  }

  useEffect(() => () => {
    checkGenerationRef.current += 1;
    clearExpiryTimer();
    stopMediaStream(streamRef.current);
    streamRef.current = null;
  }, []);

  useEffect(() => {
    verifiedRef.current = verified;
    onVerifiedChange?.(verified);
  }, [verified, onVerifiedChange]);

  useEffect(() => {
    if (active === false && verifiedRef.current) {
      invalidateVerification("OBS 虚拟摄像头已停止，原画面验证已失效，请重新启动并检测。");
    }
  }, [active, invalidateVerification]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const handleDeviceChange = () => {
      if (verifiedRef.current || streamRef.current) {
        invalidateVerification("摄像头设备列表已变化，原验证已失效，请重新检测。");
      }
    };
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [invalidateVerification]);

  async function revealDeviceLabelsIfNeeded(devices: MediaDeviceInfo[]) {
    const hasLabeledVideoDevice = devices.some((device) =>
      device.kind === "videoinput" && Boolean(device.label)
    );
    if (hasLabeledVideoDevice) return devices;

    const permissionStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });
    stopMediaStream(permissionStream);
    return navigator.mediaDevices.enumerateDevices();
  }

  async function checkAndPreview() {
    if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
      setState("error");
      setMessage("当前浏览器不支持摄像头设备检查，请使用最新版 Edge 或 Chrome。");
      return;
    }

    const generation = checkGenerationRef.current + 1;
    checkGenerationRef.current = generation;
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setVerified(false);
    clearExpiryTimer();
    setState("checking");
    setMessage("正在请求本机摄像头权限并查找 OBS Virtual Camera…");
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      devices = await revealDeviceLabelsIfNeeded(devices);
      if (checkGenerationRef.current !== generation) return;
      const obsCamera = findObsVirtualCamera(devices);
      if (!obsCamera) {
        setState("missing");
        setMessage("没有发现 OBS Virtual Camera。请先在 OBS 中启动虚拟摄像头，再重新检测。");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: obsCamera.deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      if (checkGenerationRef.current !== generation) {
        stopMediaStream(stream);
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (streamRef.current === stream) {
          stopPreview("OBS Virtual Camera 已停止或被系统释放。");
        }
      }, { once: true });
      setState("ready");
      setVerified(true);
      verifiedRef.current = true;
      expiryTimerRef.current = window.setTimeout(() => {
        invalidateVerification("摄像头验证已超过 5 分钟，请在面试前重新检测。");
      }, VERIFICATION_TTL_MS);
      setMessage(`已打开 ${obsCamera.label}。下方就是会议软件选择该摄像头后应看到的画面。`);
    } catch (cause) {
      if (checkGenerationRef.current !== generation) return;
      const name = cause instanceof DOMException ? cause.name : "";
      setState("error");
      setMessage(
        name === "NotAllowedError"
          ? "未授予摄像头权限，无法检查虚拟摄像头。"
          : name === "NotReadableError"
            ? "摄像头当前无法读取，可能正被其他软件独占。"
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "OBS Virtual Camera 不存在或已停止。"
              : "虚拟摄像头检查失败，请确认 OBS 已启动并使用最新版 Edge/Chrome。"
      );
    }
  }

  return (
    <article className="card cameraCheck">
      <div className="cardHeading">
        <h2>会议摄像头最终预览</h2>
        <span className={verified ? "ready" : ""}>
          {verified ? "画面已验证" : state === "checking" ? "检测中" : "待检测"}
        </span>
      </div>
      <div className="mediaPreview cameraPreview">
        <video ref={videoRef} muted playsInline />
        {!streamRef.current && <span>{verified ? "画面验证通过" : "OBS Virtual Camera 预览"}</span>}
      </div>
      <div className="cameraCheckActions">
        {streamRef.current ? (
          <button type="button" className="secondary" onClick={() => stopPreview()}>
            停止预览并释放摄像头
          </button>
        ) : (
          <button type="button" disabled={state === "checking"} onClick={() => void checkAndPreview()}>
            {state === "checking" ? "正在检测…" : "检测并预览虚拟摄像头"}
          </button>
        )}
      </div>
      <p className="muted">{message}</p>
      <p className="muted">浏览器只读取本机摄像头流用于本页预览，不会上传或保存画面。</p>
    </article>
  );
}
