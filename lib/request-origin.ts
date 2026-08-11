const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type RequestOriginInput = {
  method: string;
  url: string;
  headers: Pick<Headers, "get">;
  targetOrigin?: string;
};

export function isTrustedMutationRequest(request: RequestOriginInput) {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) return true;

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site" || fetchSite === "same-site") return false;

  const origin = request.headers.get("origin");
  if (!origin) {
    // Node scripts and local health tooling do not send browser fetch metadata.
    return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
  }
  if (origin === "null") return false;

  try {
    const targetOrigin = request.targetOrigin || new URL(request.url).origin;
    return new URL(origin).origin === new URL(targetOrigin).origin;
  } catch {
    return false;
  }
}
