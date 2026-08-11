import {
  getModelRuntimeConfig,
  isModelRuntimeConfigured
} from "./runtime-config";

type ModelsResponse = {
  data?: Array<{ id?: string }>;
  error?: { message?: string };
};

export async function probeConfiguredModel() {
  const runtime = await getModelRuntimeConfig();
  if (!isModelRuntimeConfigured(runtime)) {
    return {
      reachable: false,
      modelFound: false,
      models: [] as string[],
      message: "模型尚未配置"
    };
  }
  try {
    const response = await fetch(`${runtime.baseUrl}/models`, {
      method: "GET",
      headers: runtime.apiKey ? { Authorization: `Bearer ${runtime.apiKey}` } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(5_000)
    });
    const body = await response.json().catch(() => null) as ModelsResponse | null;
    if (!response.ok) {
      return {
        reachable: false,
        modelFound: false,
        models: [] as string[],
        message: body?.error?.message || `模型服务返回 HTTP ${response.status}`
      };
    }
    const models = [...new Set(
      (body?.data || [])
        .map((item) => item.id?.trim() || "")
        .filter(Boolean)
    )].slice(0, 100);
    const modelFound = models.includes(runtime.model);
    return {
      reachable: true,
      modelFound,
      models,
      message: modelFound
        ? `连接正常，已找到模型 ${runtime.model}`
        : models.length > 0
          ? `服务可达，但未找到模型 ${runtime.model}`
          : "服务可达，但没有返回可用模型"
    };
  } catch (cause) {
    const timeout = cause instanceof DOMException && cause.name === "TimeoutError";
    return {
      reachable: false,
      modelFound: false,
      models: [] as string[],
      message: timeout ? "模型服务连接超时" : "无法连接模型服务"
    };
  }
}
