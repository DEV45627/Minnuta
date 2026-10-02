const TOKEN_KEY = "minuta_token";
const USER_KEY = "minuta_user";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function requireAuth() {
  if (!getToken()) {
    window.location.href = "/login";
    return false;
  }
  return true;
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text };
  }
  if (!res.ok) {
    const detail = data?.detail;
    const msg = Array.isArray(detail)
      ? detail.map((d) => d.msg || JSON.stringify(d)).join(", ")
      : detail || res.statusText || "Request failed";
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function toast(message, kind = "") {
  let host = document.querySelector(".toast-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export function initials(name = "?") {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function formatWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Copy text via Clipboard API with execCommand fallback. */
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

/**
 * Share a meeting invite. Uses Web Share API when available, otherwise copies.
 * @returns {"shared"|"copied"}
 */
export async function shareMeetingLink({ title, link }) {
  const shareData = {
    title: title || "Minuta meeting",
    text: `Join "${title}" on Minuta`,
    url: link,
  };
  if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
    try {
      await navigator.share(shareData);
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") throw err;
    }
  }
  await copyText(link);
  return "copied";
}

export function inviteCardHtml({ title, link, publicId }) {
  return `
    <div class="share-panel">
      <p class="share-success">Meeting Created Successfully!</p>
      <p class="muted" style="margin:0.5rem 0 0.15rem">Meeting</p>
      <h3 class="share-title">${title}</h3>
      <p class="muted" style="margin:0.75rem 0 0.15rem">Join Link</p>
      <div class="share-link-row">
        <code class="share-link" id="share-link-value">${link}</code>
      </div>
      <p class="muted" style="margin-top:0.45rem;font-size:0.85rem">Meeting ID: <strong>${publicId}</strong></p>
      <div class="share-actions">
        <button class="btn btn-secondary" type="button" data-action="copy-link">Copy Link</button>
        <button class="btn btn-primary" type="button" data-action="share-link">Share</button>
        <a class="btn btn-ghost" href="/meeting/${publicId}">Join now</a>
        <a class="btn btn-ghost" href="/meetings/${publicId}">Open details</a>
      </div>
      <p class="muted share-note">
        Send this link to anyone. On a public HTTPS host they can join from any network —
        no same Wi-Fi, host IP, localhost, or port required. Set <code>MINUTA_BASE_URL</code> to your domain.
      </p>
    </div>
  `;
}

