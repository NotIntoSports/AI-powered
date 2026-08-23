export type ControlApiFailure = {
  status: number;
  code: string;
  message: string;
};

export type ControlApiResult<T> =
  | { ok: true; data: T | null }
  | { ok: false; failure: ControlApiFailure };

function safeFailurePayload(payload: unknown): Pick<ControlApiFailure, "code" | "message"> {
  if (!payload || typeof payload !== "object") return { code: "HTTP_ERROR", message: "" };
  const source = payload as Record<string, unknown>;
  return {
    code: typeof source.code === "string" ? source.code.slice(0, 80) : "HTTP_ERROR",
    message: typeof source.message === "string" ? source.message.slice(0, 200) : ""
  };
}

export async function parseControlApiResponse<T>(response: Response): Promise<ControlApiResult<T>> {
  if (response.ok) {
    if (response.status === 204) return { ok: true, data: null };
    try {
      return { ok: true, data: await response.json() as T };
    } catch {
      return { ok: false, failure: { status: response.status, code: "INVALID_RESPONSE", message: "" } };
    }
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON upstream errors are represented only by status.
  }
  return { ok: false, failure: { status: response.status, ...safeFailurePayload(payload) } };
}
