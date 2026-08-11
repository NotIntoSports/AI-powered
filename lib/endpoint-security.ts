export function isSecureEndpoint(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function areEquivalentBaseUrls(left: string, right: string) {
  try {
    return normalizeBaseUrl(left) === normalizeBaseUrl(right);
  } catch {
    return false;
  }
}

export function selectScopedApiKey(input: {
  explicitKey?: string;
  targetBaseUrl: string;
  fallbackBaseUrl: string;
  fallbackApiKey: string;
}) {
  if (input.explicitKey?.trim()) return input.explicitKey.trim();
  return areEquivalentBaseUrls(input.targetBaseUrl, input.fallbackBaseUrl)
    ? input.fallbackApiKey
    : "";
}
