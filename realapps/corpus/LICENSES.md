# Licences of the open-source apps in the realapps corpus

Only MIT, Apache-2.0 or BSD-licensed apps are used. Sources are not vendored into this repo. `prepare_oss.sh`
clones each app at its pinned commit on the VM (`~/gcl/real-cache/oss/<name>`) and applies the GenClass
integration patch (`patch_oss.py`). The apps' own dependencies are installed from npm.

| corpus name | repository | commit | licence | copyright / notice | changes made |
|---|---|---|---|---|---|
| `oss-react-redux-conduit` | https://github.com/gothinkster/react-redux-realworld-example-app | `ee72eba4056392c95a27bc48d385d3f54ba38a18` | MIT (`LICENSE.md`) | Copyright (c) 2020 GoThinkster | `src/store.js`: `genclassEnhancer(rt, { name: 'conduit' })` added to `createStore`, plus the init import |
| `oss-rtk-conduit` | https://github.com/khaledosman/react-redux-realworld-example-app | `53b0b4c0b8c371053a8d082ff9a42bfae68f3755` | MIT (`LICENSE.md`) | Copyright (c) 2020 GoThinkster (fork by Khaled Osman) | `src/app/store.js`: `enhancers: (d) => [...d, genclassEnhancer(...)]` in `configureStore`, plus the init import |
| `oss-vue3-conduit` | https://github.com/mutoe/vue3-realworld-example-app | `741c215ef0f674f90fcb03c5493a1b3a3a7f1b03` | MIT (`LICENSE`, `package.json`) | Copyright (c) 2021 Dongsen | `src/main.ts`: one init import (observe-only) |
| `oss-solid-conduit` | https://github.com/solidjs/solid-realworld | `f6e77ecd652bf32f0dc9238f291313fd1af7e98b` | MIT (`package.json` "license": "MIT"; no separate licence file) | Ryan Carniato | `src/index.js`: one init import (observe-only); an `index.html` entry for Vite |

The mock backend for these apps (`src/world/ext/conduit.ts`) is written from the public RealWorld API spec
(https://realworld-docs.netlify.app/specifications/backend/endpoints/); no backend code is copied.

Bundled framework and library dependencies of the apps written for the corpus (React, Redux Toolkit, Zustand,
TanStack Query, SWR, MobX, Vue, Pinia, Svelte, Solid, Preact, Lit, jQuery, Alpine, axios) are MIT-licensed npm
packages listed in `realapps/package.json`.
