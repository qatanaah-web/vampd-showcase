// ── Vamp'd showcase ── In the product: web/lib/paths.ts.
// One place for base path + public origin, because the app is served under /vampd behind a rewrite.

// One place for everything that depends on where the app is mounted and what its public address is.
//   BASE_PATH=/vampd      (build time)  the app lives under https://host/vampd; empty = at the root
//   PUBLIC_ORIGIN=https://theniche.app  the address people see (the app runs behind a rewrite, so the request's own
//                                       host is not it). Empty: the browser's own origin on the client.
// next.config.ts copies both into NEXT_PUBLIC_* so server and client bundles agree.
// next/link, next/navigation and file-based metadata add the base path themselves; raw fetch(), <img src>,
// EventSource, location.* and hand-built share links do not, so they go through here.

/** "" or "/vampd". */
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
/** "" or "https://theniche.app" (no trailing slash). */
export const ORIGIN = (process.env.NEXT_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
/** The parent brand's site. */
export const NICHE_URL = "https://theniche.app";

/** A root-relative app path ("/api/x", "/mark.png") as the browser must request it. */
export const withBase = (p: string) => `${BASE}${p}`;
/** A full public link to an app path, for sharing and copying. */
export const publicUrl = (p = "") => `${ORIGIN || (typeof location !== "undefined" ? location.origin : "")}${BASE}${p}`;
/** Where in-app links to the home page point. The home page lives at "/" and, identically, at "/markets". Links use
 *  the second because of the Vercel rewrite in front of the app: Vercel renames a navigation fetch for <base> to
 *  "<base>.rsc", which is outside the path it forwards here, so a link to "/" could only ever do a full page load. */
export const HOME = "/markets";
