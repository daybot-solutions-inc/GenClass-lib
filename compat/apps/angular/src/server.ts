import { AngularNodeAppEngine, createNodeRequestHandler, isMainModule, writeResponseToNodeResponse } from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

/**
 * SSR safety probe (compat runner): what importing GenClass's one line does on the server. Expected: an inert
 * runtime, the server's fetch untouched, no devtools globals added to the Node process.
 */
app.get('/ssr-check', async (_req, res) => {
  const HOOKS = ['__REACT_DEVTOOLS_GLOBAL_HOOK__', '__REDUX_DEVTOOLS_EXTENSION__', '__REDUX_DEVTOOLS_EXTENSION_COMPOSE__'];
  const g = globalThis as Record<string, unknown>;
  const fetchBefore = g['fetch'];
  const before = HOOKS.filter((k) => k in g);
  try {
    const rt = (await import('@genclass/runtime/auto')).default;
    res.json({
      fetchSame: g['fetch'] === fetchBefore,
      state: rt.status.state,
      mode: rt.mode,
      stores: rt.stores().length,
      globalsAdded: HOOKS.filter((k) => k in g && !before.includes(k)),
      error: null,
    });
  } catch (e) {
    res.json({ error: String((e as Error)?.stack ?? e) });
  }
});

app.use(express.static(browserDistFolder, { maxAge: '1y', index: false, redirect: false }));

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = Number(process.env['PORT'] || 4000);
  const host = process.env['HOST'] || 'localhost';
  app.listen(port, host, (error) => {
    if (error) throw error;
    console.log(`Node Express server listening on http://${host}:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
