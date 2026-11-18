// ── Vamp'd showcase ── In the product: web/lib/zoom.ts.
// Helper used by LiveChart for pointer math inside CSS-zoomed pages.

// Large screens scale the whole page up a little with CSS zoom (app/adaptive.css, --z). Inside a zoomed page,
// getBoundingClientRect() and pointer coordinates are in screen pixels while layout sizes (clientWidth, canvas
// drawing units, transforms) are in the page's own pixels: divide a measured distance by this to use it in layout.
export const zoomOf = (el: Element | null): number => (el && (el as Element & { currentCSSZoom?: number }).currentCSSZoom) || 1;
