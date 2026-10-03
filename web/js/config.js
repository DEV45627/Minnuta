/**
 * Minuta Configuration Helper
 * Resolves Backend API base URL and WebSocket Signaling URL.
 */

export function getApiBaseUrl() {
  if (window.MINUTA_API_URL) return window.MINUTA_API_URL.replace(/\/$/, "");
  const meta = document.querySelector('meta[name="minuta-api-url"]');
  if (meta && meta.content) return meta.content.replace(/\/$/, "");
  const localOverride = localStorage.getItem("minuta_api_url");
  if (localOverride) return localOverride.replace(/\/$/, "");
  return location.origin;
}

export function getSignalingWsUrl(publicId, params = {}) {
  if (window.MINUTA_SIGNALING_URL) {
    const baseUrl = window.MINUTA_SIGNALING_URL.replace(/\/$/, "");
    const wsProto = baseUrl.startsWith("https") ? "wss" : baseUrl.startsWith("http") ? "ws" : "wss";
    const cleanHost = baseUrl.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "");
    const qs = new URLSearchParams(params).toString();
    return `${wsProto}://${cleanHost}/ws/meetings/${publicId}?${qs}`;
  }
  const meta = document.querySelector('meta[name="minuta-signaling-url"]');
  if (meta && meta.content) {
    const baseUrl = meta.content.replace(/\/$/, "");
    const wsProto = baseUrl.startsWith("https") ? "wss" : baseUrl.startsWith("http") ? "ws" : "wss";
    const cleanHost = baseUrl.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "");
    const qs = new URLSearchParams(params).toString();
    return `${wsProto}://${cleanHost}/ws/meetings/${publicId}?${qs}`;
  }
  const localOverride = localStorage.getItem("minuta_signaling_url");
  if (localOverride) {
    const baseUrl = localOverride.replace(/\/$/, "");
    const wsProto = baseUrl.startsWith("https") ? "wss" : baseUrl.startsWith("http") ? "ws" : "wss";
    const cleanHost = baseUrl.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "");
    const qs = new URLSearchParams(params).toString();
    return `${wsProto}://${cleanHost}/ws/meetings/${publicId}?${qs}`;
  }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const qs = new URLSearchParams(params).toString();
  return `${proto}://${location.host}/ws/meetings/${publicId}?${qs}`;
}
