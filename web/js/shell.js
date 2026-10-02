import { getUser, clearSession, initials } from "/static/js/api.js";

const NAV = [
  { href: "/dashboard",   icon: "⊞", label: "Dashboard" },
  { href: "/meetings",    icon: "◷", label: "Meetings" },
  { href: "/calendar",    icon: "▦", label: "Calendar" },
  { href: "/notes",       icon: "≡", label: "Notes" },
  { href: "/transcripts", icon: "◉", label: "Transcripts" },
  { href: "/tools",       icon: "⋯", label: "Tools" },
];

const NAV_BOTTOM = [
  { href: "/settings", icon: "◎", label: "Settings" },
  { href: "/profile",  icon: "○", label: "Profile" },
];

export function mountShell({ title = "Minuta", active = "/dashboard" } = {}) {
  const user = getUser() || { full_name: "User" };
  const root = document.getElementById("app");
  if (!root) return;

  root.innerHTML = `
    <div class="ambient" aria-hidden="true"></div>
    <div class="ambient-grid" aria-hidden="true"></div>
    <div id="toast-host" class="toast-host"></div>
    <div class="app-shell">
      <aside class="app-sidebar">
        <div class="sidebar-logo">
          <a class="brand-mark" href="/dashboard">
            <span class="brand-glyph"></span>
            Minuta
          </a>
        </div>

        <div class="sidebar-section-label">Workspace</div>
        <nav>
          ${NAV.map((n) =>
            `<a href="${n.href}" class="${n.href === active ? "active" : ""}">
              <span class="nav-icon">${n.icon}</span>${n.label}
            </a>`
          ).join("")}
        </nav>

        <div class="sidebar-footer">
          <div class="sidebar-section-label">Account</div>
          ${NAV_BOTTOM.map((n) =>
            `<a href="${n.href}"><span class="nav-icon">${n.icon}</span>${n.label}</a>`
          ).join("")}
          <button
            id="logout-btn"
            class="btn btn-ghost btn-sm"
            style="width:100%;justify-content:flex-start;gap:0.6rem;padding:0.5rem 0.75rem;font-size:0.85rem;color:var(--text-2);margin-top:2px"
          >
            <span class="nav-icon" style="font-style:normal">↩</span>Sign out
          </button>
        </div>
      </aside>

      <div class="app-main">
        <header class="app-top">
          <span class="app-page-title">${title}</span>
          <form class="search-box" id="global-search">
            <input name="q" placeholder="Search meetings, transcripts…" />
          </form>
          <div style="display:flex;align-items:center;gap:0.6rem">
            <a href="/meetings/create" class="btn btn-primary btn-sm">New meeting</a>
            <button class="avatar-btn" title="${user.full_name}" id="avatar-btn">${initials(user.full_name)}</button>
          </div>
        </header>
        <div class="app-content" id="page-content"></div>
      </div>
    </div>
  `;

  document.getElementById("logout-btn")?.addEventListener("click", () => {
    clearSession();
    window.location.href = "/login";
  });
  document.getElementById("avatar-btn")?.addEventListener("click", () => {
    window.location.href = "/profile";
  });
  document.getElementById("global-search")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = new FormData(e.target).get("q");
    window.location.href = `/meetings?q=${encodeURIComponent(q || "")}`;
  });

  return document.getElementById("page-content");
}
