import '@genclass/runtime/auto'; // GenClass, first line of the browser entry (observe by default), as `npx @genclass/runtime init` writes it
import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig, xhrConfig } from './app/app.config';

// ?layer=xhr: HttpClient on its XMLHttpRequest backend (withXhr); otherwise Angular's default (FetchBackend).
const layer = new URLSearchParams(location.search).get('layer');
bootstrapApplication(App, layer === 'xhr' ? xhrConfig : appConfig).catch((err) => console.error(err));
