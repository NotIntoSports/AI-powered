export type ManagedObsFailureStage =
  | "configuration"
  | "process"
  | "port"
  | "auth"
  | "scene"
  | "virtual-camera";

export type ManagedObsState =
  | { status: "idle" | "stopped" }
  | { status: "not-installed" }
  | { status: "blocked-by-external-obs"; processes: number[] }
  | { status: "starting"; attempt: number; maxAttempts: number }
  | { status: "ready"; version: string; virtualCameraActive: boolean }
  | { status: "failed"; stage: ManagedObsFailureStage; code: string };

export type PrerequisiteStatus = {
  obsBundled: boolean;
  virtualCameraRegistered: boolean;
  virtualAudioInstalled: boolean;
  virtualAudioDriverStaged: boolean;
};

export type PrerequisiteInstallResult =
  | { installed: true; rebootRequired: boolean }
  | { installed: false; error: { code: string; message?: string } };

export type InterventionAction = "begin" | "end" | "resume" | "mute";

export interface ManagedObsDesktopBridge {
  getPrerequisiteStatus(): Promise<PrerequisiteStatus>;
  installPrerequisite(component: "obs" | "virtual-audio"): Promise<PrerequisiteInstallResult>;
  ensureManagedObs(): Promise<ManagedObsState>;
  getManagedObsState(): Promise<ManagedObsState>;
  setManagedObsVirtualCamera(active: boolean): Promise<ManagedObsState>;
  setManagedObsInterventionRouting(action: InterventionAction): Promise<ManagedObsState>;
  stopManagedObs(): Promise<ManagedObsState>;
  resetManagedObsConfig(): Promise<ManagedObsState>;
}

export type ManagedObsBadge =
  | "idle"
  | "starting"
  | "connecting"
  | "ready"
  | "failed"
  | "needs-authorization";

const stageLabels: Record<ManagedObsFailureStage, string> = {
  configuration: "配置",
  process: "进程启动",
  port: "控制端口",
  auth: "安全认证",
  scene: "场景配置",
  "virtual-camera": "虚拟摄像头"
};

const managedObsErrorMessages: Record<string, string> = {
  OBS_CONFIG_WRITE_FAILED: "无法写入专用 OBS 配置。请重置配置后重试。",
  OBS_CONFIG_INVALID: "专用 OBS 配置无效。请重置配置后重试。",
  OBS_SECURE_STORAGE_UNAVAILABLE: "Windows 安全存储当前不可用，已停止启动 OBS。请重新登录 Windows 后重试。",
  OBS_SECURE_STORAGE_FAILED: "Windows 安全存储无法读取 OBS 连接凭据。请重置专用配置后重试。",
  OBS_SPAWN_FAILED: "专用 OBS 启动失败。请确认安全软件没有阻止客户端。",
  OBS_PROCESS_EXITED: "专用 OBS 在启动过程中退出。请重置配置后重试。",
  OBS_PROCESS_TERMINATION_FAILED: "专用 OBS 无法安全停止。请稍后重试；客户端不会关闭你自己的 OBS。",
  OBS_PORT_IN_USE: "OBS 控制端口 4455 已被其他程序占用。请关闭占用程序后重试。",
  OBS_PORT_NOT_READY: "专用 OBS 未在 30 秒内开放控制端口。请重置配置后重试。",
  OBS_AUTH_FAILED: "客户端无法通过 OBS 安全认证。请重置专用配置后重试。",
  OBS_CONNECTION_LOST: "与专用 OBS 的安全连接已断开，请重新自动连接。",
  OBS_SCENE_CONFIG_FAILED: "数字人场景配置失败。请重置专用配置后重试。",
  OBS_INTERVENTION_ROUTING_FAILED: "人工麦克风与 AI 音频切换失败。请重置专用 OBS 配置后重试。",
  OBS_VIRTUAL_CAMERA_NOT_REGISTERED: "OBS 虚拟摄像头尚未注册，请先完成管理员授权。",
  OBS_VIRTUAL_CAMERA_FAILED: "OBS 已连接，但虚拟摄像头无法启动。请先重新注册组件。",
  OBS_NOT_RUNNING: "专用 OBS 尚未运行，请重新自动连接。"
};

const installErrorMessages: Record<string, string> = {
  "uac-cancelled": "管理员授权已取消。需要重新授权后才能注册系统组件。",
  "resource-missing": "安装包中的组件文件缺失，请重新下载并安装客户端。",
  "signature-rejected": "组件的官方数字签名验证未通过，已停止注册。",
  "module-load-failed": "Windows PowerShell 安全验证模块无法加载。请重启客户端后重试。",
  "hash-mismatch": "组件完整性校验未通过，已停止注册。",
  "verification-failed": "组件安全验证未通过，已停止注册。",
  "registration-failed": "Windows 未能注册 OBS 虚拟摄像头。请重新授权后重试。",
  "install-failed": "Windows 未能安装所选系统组件。",
  unknown: "系统组件处理过程中发生异常，请重试。"
};

const badgeLabels: Record<ManagedObsBadge, string> = {
  idle: "未连接",
  starting: "正在启动",
  connecting: "正在连接",
  ready: "已连接",
  failed: "启动失败",
  "needs-authorization": "需要授权"
};

export function formatManagedObsFailure(failure: {
  stage: ManagedObsFailureStage;
  code: string;
}) {
  const known = managedObsErrorMessages[failure.code];
  if (known) return known;
  const code = /^[A-Z][A-Z0-9_-]{2,80}$/.test(failure.code) ? `（错误代码：${failure.code}）` : "";
  return `专用 OBS 在${stageLabels[failure.stage]}阶段遇到问题${code}，请重试或重置专用配置。`;
}

export function formatPrerequisiteInstallError(error: { code: string; message?: string }) {
  return installErrorMessages[error.code] ?? installErrorMessages.unknown;
}

export function formatUnexpectedObsError(action: string) {
  return `${action}未完成。请重试；如果问题持续，请重置专用 OBS 配置。`;
}

export function managedObsBadgeLabel(badge: ManagedObsBadge, version = "") {
  if (badge === "ready" && version) return `${badgeLabels[badge]} ${version}`;
  return badgeLabels[badge];
}

export function failureNeedsAuthorization(failure: { stage: ManagedObsFailureStage; code: string }) {
  return failure.stage === "virtual-camera" && failure.code === "OBS_VIRTUAL_CAMERA_NOT_REGISTERED";
}

export function getManagedObsDesktopBridge() {
  return (window as typeof window & { aiInterviewerDesktop?: ManagedObsDesktopBridge }).aiInterviewerDesktop;
}
