// GenClass, in the browser only: SvelteKit loads client hooks before the app starts.
// "@genclass/runtime/auto" observes (reports what it sees, never changes anything). To let it act, switch to
// "@genclass/runtime/auto/guard". Add ?genclass=off to the URL to turn it off for a page load.
import genclass from '@genclass/runtime/auto';

// The devtools overlay, in development only (not in your production bundle).
if (import.meta.env.DEV) import('@genclass/runtime/devtools').then((d) => d.mountDevtools(genclass));
