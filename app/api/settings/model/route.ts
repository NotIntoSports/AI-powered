import { NextResponse } from "next/server";
import { z } from "zod";
import {
  clearModelRuntimeConfig,
  getModelRuntimeConfig,
  isLocalModelEndpoint,
  isModelRuntimeConfigured,
  isSecureModelEndpoint,
  saveModelRuntimeConfig
} from "../../../../lib/runtime-config";

const updateSchema = z.object({
  apiKey: z.string().trim().max(2000).optional(),
  baseUrl: z.string().trim().url().max(500).refine(isSecureModelEndpoint, {
    message: "远程模型地址必须使用 HTTPS；只有本机地址允许 HTTP"
  }),
  model: z.string().trim().min(1).max(200)
});

function publicConfig(config: Awaited<ReturnType<typeof getModelRuntimeConfig>>) {
  return {
    apiKeyConfigured: Boolean(config.apiKey),
    modelConfigured: isModelRuntimeConfigured(config),
    localEndpoint: isLocalModelEndpoint(config.baseUrl),
    baseUrl: config.baseUrl,
    model: config.model,
    source: config.source
  };
}

export async function GET() {
  return NextResponse.json(publicConfig(await getModelRuntimeConfig()), {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export async function POST(request: Request) {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { code: "INVALID_CONFIG", message: parsed.error.issues[0]?.message || "模型配置不合法" },
      { status: 422 }
    );
  }
  try {
    const config = await saveModelRuntimeConfig(parsed.data);
    return NextResponse.json(publicConfig(config), {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "UNKNOWN";
    return NextResponse.json(
      {
        code: "CONFIG_SAVE_FAILED",
        message: code === "DPAPI_UNAVAILABLE"
          ? "当前系统不支持 Windows DPAPI，请改用 .env.local"
          : "无法安全保存模型配置"
      },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  await clearModelRuntimeConfig();
  return NextResponse.json({ deleted: true }, {
    headers: { "Cache-Control": "no-store" }
  });
}
