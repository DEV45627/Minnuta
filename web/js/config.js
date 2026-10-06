/**
 * Minuta Configuration Helper
 * Resolves Backend API base URL and WebSocket Signaling URL.
 */

export function getApiBaseUrl() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const paramUrl = urlParams.get("api_url");
    if (paramUrl) return paramUrl.replace(/\/$/, "");
  } catch (_) {}

  if (window.MINUTA_API_URL) return window.MINUTA_API_URL.replace(/\/$/, "");
  const meta = document.querySelector('meta[name="minuta-api-url"]');
  if (meta && meta.content) return meta.content.replace(/\/$/, "");
  const localOverride = localStorage.getItem("minuta_api_url");
  if (localOverride) return localOverride.replace(/\/$/, "");
  return location.origin;
}

export function getSignalingWsUrl(publicId, params = {}) {
  let baseUrl = null;
  try {
    const urlParams = new URLSearchParams(window.location.search);
    baseUrl = urlParams.get("signaling_url");
  } catch (_) {}

  if (!baseUrl && window.MINUTA_SIGNALING_URL) {
    baseUrl = window.MINUTA_SIGNALING_URL;
  }
  if (!baseUrl) {
    const meta = document.querySelector('meta[name="minuta-signaling-url"]');
    if (meta && meta.content) baseUrl = meta.content;
  }
  if (!baseUrl) {
    baseUrl = localStorage.getItem("minuta_signaling_url");
  }
  if (!baseUrl && window.MINUTA_API_URL) {
    baseUrl = window.MINUTA_API_URL;
  }

  const qs = new URLSearchParams(params).toString();
  const queryStr = qs ? `?${qs}` : "";

  if (baseUrl) {
    const cleanUrl = baseUrl.replace(/\/$/, "");
    const wsProto = cleanUrl.startsWith("https") ? "wss" : cleanUrl.startsWith("http") ? "ws" : cleanUrl.startsWith("wss") ? "wss" : "ws";
    const cleanHost = cleanUrl.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "");
    return `${wsProto}://${cleanHost}/ws/meetings/${publicId}${queryStr}`;
  }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/meetings/${publicId}${queryStr}`;
}
