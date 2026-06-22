// ═══════════════════════════════════════════════════════════════════
//  sidebarResize.js — Drag-to-resize sidebar
//  Adds a thin invisible handle on the sidebar's right edge.
//  Drag it left/right to grow or shrink the sidebar width.
//
//  HOW TO ADD:
//  1. In index.html, inside <aside class="sidebar"> add one line
//     as the FIRST child:
//       <div class="sidebar-resize-handle" id="sidebar-resize-handle"></div>
//  2. Load this script anywhere after the DOM exists, e.g. just
//     before main.js:
//       <script src="js/sidebarResize.js"></script>
// ═══════════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", () => {
    const sidebar = document.querySelector(".sidebar");
    const handle  = document.getElementById("sidebar-resize-handle");
    if (!sidebar || !handle) return;

    const MIN_WIDTH = 220;
    const MAX_WIDTH = 640;

    // Restore saved width from this session (in-memory only, no localStorage)
    let currentWidth = sidebar.getBoundingClientRect().width;

    let dragging   = false;
    let startX     = 0;
    let startWidth = 0;

    handle.addEventListener("mousedown", (e) => {
        dragging   = true;
        startX     = e.clientX;
        startWidth = sidebar.getBoundingClientRect().width;
        handle.classList.add("dragging");
        document.body.classList.add("sidebar-resizing");
        e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const delta    = e.clientX - startX;
        let   newWidth = startWidth + delta;
        newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth));
        sidebar.style.width     = newWidth + "px";
        sidebar.style.minWidth  = newWidth + "px";
        currentWidth = newWidth;

        // Let any chart relying on container size know it should resize
        window.dispatchEvent(new Event("sidebarResized"));
    });

    window.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove("dragging");
        document.body.classList.remove("sidebar-resizing");
    });

    // Double-click handle to reset to default width
    handle.addEventListener("dblclick", () => {
        sidebar.style.width    = "256px";
        sidebar.style.minWidth = "256px";
        window.dispatchEvent(new Event("sidebarResized"));
    });
});
