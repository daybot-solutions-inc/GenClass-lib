import { RenderMode, ServerRoute } from '@angular/ssr';

// Rendered per request (the page depends on ?layer=&s=), not prerendered.
export const serverRoutes: ServerRoute[] = [{ path: '**', renderMode: RenderMode.Server }];
