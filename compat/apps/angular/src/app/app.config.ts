import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideClientHydration } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

/** Angular's defaults (ng new --ssr): router, hydration, HttpClient on FetchBackend (Angular's default backend). */
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideRouter(routes), provideHttpClient(), provideClientHydration()],
};

/** The same with HttpClient on XMLHttpRequest (withXhr), browser only. */
export const xhrConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideRouter(routes), provideHttpClient(withXhr()), provideClientHydration()],
};
