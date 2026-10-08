// App-wide notifications for web-component apps: a live region in the document (light DOM, outside every
// component's shadow root) so assistive tech, global CSS and error monitoring see them. Errors use role=alert.
let region: HTMLElement | null = null;

export function toast(message: string, kind: "error" | "info" = "error", ms = 4000): void {
  if (!region || !region.isConnected) {
    region = document.createElement("div");
    region.className = "toasts";
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  // the same message twice in a row is shown once
  const last = region.lastElementChild as HTMLElement | null;
  if (last && last.textContent === message) return;
  const p = document.createElement("p");
  p.className = `toast toast-${kind}`;
  p.setAttribute("role", kind === "error" ? "alert" : "status");
  p.textContent = message;
  region.appendChild(p);
  setTimeout(() => p.remove(), ms);
}
