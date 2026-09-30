/**
 * ds-store — Proxy-based reactive store + hash router (zero dependencies).
 *
 *   const store = createStore({ theme: "dark", route: null, layout: null, params: {} });
 *   initTheme(store);   // persists `theme` (localStorage `ds-theme`) — survives reloads
 *   initRouter(store);  // #/dashboard · #/case/:id · #/case/:id/dossier
 *
 * Router is hashchange-driven: browser back/forward update state natively.
 */

// ---- Store ------------------------------------------------------------------

export function createStore(initialState = {}) {
  const listeners = new Set();
  const state = new Proxy(initialState, {
    set(target, key, value) {
      target[key] = value;
      listeners.forEach((fn) => fn(key, value));
      return true;
    },
  });
  return {
    state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get(key) { return state[key]; },
    set(key, value) { state[key] = value; },
  };
}

// ---- Theme (persists across reloads) ------------------------------------------

const THEME_KEY = "ds-theme";

export function initTheme(store, storageKey = THEME_KEY) {
  if (typeof document === "undefined") return () => {};
  const apply = (theme) => document.documentElement.setAttribute("data-theme", theme);
  const theme = localStorage.getItem(storageKey) || store.get("theme") || "dark";
  store.set("theme", theme);
  apply(theme);
  return store.subscribe((key, value) => {
    if (key !== "theme") return;
    localStorage.setItem(storageKey, value);
    apply(value);
  });
}

// ---- Router — #/dashboard · #/case/:id · #/case/:id/dossier -------------------

export const ROUTES = [
  { pattern: "#/dashboard", layout: "DashboardLayout", root: "ds-layout-dashboard" },
  { pattern: "#/case/:id/dossier", layout: "DossierLayout", root: "ds-layout-dossier" },
  { pattern: "#/case/:id", layout: "CaseDetailLayout", root: "ds-layout-case-detail" },
];

export function matchRoute(hash) {
  const clean = String(hash || "").split("?")[0].replace(/^#\/?/, "") || "dashboard";
  const segs = clean.split("/").filter(Boolean);
  for (const route of ROUTES) {
    const parts = route.pattern.replace(/^#\//, "").split("/");
    if (parts.length !== segs.length) continue;
    const params = {};
    const ok = parts.every((part, i) => {
      if (part[0] === ":") { params[part.slice(1)] = decodeURIComponent(segs[i]); return true; }
      return part === segs[i];
    });
    if (ok) return { ...route, params };
  }
  return { pattern: null, layout: null, root: null, params: {} };
}

export function initRouter(store) {
  if (typeof window === "undefined") return () => {};
  const sync = () => {
    const match = matchRoute(window.location.hash);
    store.set("route", match.pattern);
    store.set("layout", match.layout);
    store.set("params", match.params);
  };
  window.addEventListener("hashchange", sync);
  sync();
  return () => window.removeEventListener("hashchange", sync);
}

export function navigate(path) {
  window.location.hash = `#/${String(path).replace(/^#/, "").replace(/^\/+/, "")}`;
}
