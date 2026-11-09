# DESIGN.md - Staff Attendance Tracking App & Kuberan Design System Specification
<!-- Specification Standard: Google Stitch (Google Labs open-source DESIGN.md standard) -->
<!-- Author: Kuberan Silks Heritage Engineering -->
<!-- Version: 1.3.0 -->
<!-- Status: Active & Enforced -->

---

## 1. Design Philosophy & Application Vibe

The Staff Attendance Tracking App is a local-first Progressive Web App (PWA) engineered for rapid showroom operations, Gemini AI Vision handwriting extraction, payroll matrix computation, and executive reporting. It pairs high-density operational clarity with the Kuberan Silks design system standard.

### Core Principles
1. **Heritage & Operational Precision:** Supports both High-Contrast Dark Mode (for low-glare showroom scanning) and Warm Pearl Ivory Light Mode (`#FAFAF7`) aligned with Imperial Maroon (`#6B1D2F`), Antique Temple Gold (`#C5A059`), and Charcoal Slate (`#1C1917`).
2. **Mobile-First Showroom Velocity:** Built for one-handed mobile camera capture, instant rotation/contrast enhancement, and 1-tap WhatsApp/PDF/Excel reporting.
3. **Uncompromising Accessibility:** WCAG 2.2 AA / AAA contrast compliance, minimum `44 × 44 px` mobile tap targets, keyboard `Escape` modal dismissal, and visible focus rings.

---

## 2. Design Tokens (Color Hierarchy)

```css
:root {
  /* Kuberan Master Brand Identity Tokens */
  --color-brand-primary:      #6B1D2F; /* Imperial Kumkum Maroon */
  --color-brand-accent:       #C5A059; /* Antique Temple Gold */
  --color-brand-secondary:    #1B4D3E; /* Auspicious Temple Green */
  --color-canvas-base:        #FAFAF7; /* Warm Pearl Ivory */
  --color-text-primary:       #1C1917; /* Charcoal Slate */

  /* Operational Dashboard & Semantic Status Tokens */
  --emerald-text:             #10b981; /* Full Shift / Present */
  --amber-text:               #f59e0b; /* Late IN / Unclosed Break Warning */
  --crimson-text:             #ef4444; /* Shortfall / Absent / Discrepancy Danger */
}
```

---

## 3. Typography & Hierarchy

* **Headings:** `"Outfit", "Plus Jakarta Sans", sans-serif` — crisp geometric legibility for KPI metrics and modal titles.
* **Body & Tabular Data:** `"Inter", -apple-system, BlinkMacSystemFont, sans-serif` — tabular numerals (`font-variant-numeric: tabular-nums`) for time punches (`10:00 AM`, `08:30 PM`), hours worked, and shortfall columns.
* **Monospace:** `"JetBrains Mono", monospace` — used for API key inputs, WhatsApp preview templates, and time badges.

---

## 4. Accessibility & Interaction Contracts

1. **Touch Targets:** All primary action buttons, camera triggers, and filter chips enforce a minimum `44 × 44 px` touch target on mobile viewports.
2. **Keyboard Navigation & Focus:**
   * Global `Escape` key handler closes the topmost active modal overlay.
   * `Enter` key submits quick-add forms in the Master Staff Directory and Edit Record modals.
   * Visible focus outlines (`2px solid var(--color-brand-accent)`) on interactive controls.
3. **Zero FOUC Theme Pre-Loading:** Synchronous `<head>` script restores Light/Dark theme state from `localStorage` prior to first paint.
