# Licences of the open-source apps in the realapps corpus

Only MIT, Apache-2.0 or BSD-licensed apps are used (all current apps are MIT). Sources are not vendored into this
repo. `prepare_oss.sh` clones each app at its pinned commit on the VM (`~/gcl/real-cache/oss/<name>`) and applies
the GenClass integration patch (`patch_oss.py`). The apps' own dependencies are installed from npm.

| corpus name | repository | commit | licence | copyright / notice | changes made |
|---|---|---|---|---|---|
| `oss-react-redux-conduit` | https://github.com/gothinkster/react-redux-realworld-example-app | `ee72eba4056392c95a27bc48d385d3f54ba38a18` | MIT (`LICENSE.md`) | Copyright (c) 2020 GoThinkster | `src/store.js`: `genclassEnhancer(rt, { name: 'conduit' })` added to `createStore`, plus the init import |
| `oss-rtk-conduit` | https://github.com/khaledosman/react-redux-realworld-example-app | `53b0b4c0b8c371053a8d082ff9a42bfae68f3755` | MIT (`LICENSE.md`) | Copyright (c) 2020 GoThinkster (fork by Khaled Osman) | `src/app/store.js`: `enhancers: (d) => [...d, genclassEnhancer(...)]` in `configureStore`, plus the init import |
| `oss-vue3-conduit` | https://github.com/mutoe/vue3-realworld-example-app | `741c215ef0f674f90fcb03c5493a1b3a3a7f1b03` | MIT (`LICENSE`, `package.json`) | Copyright (c) 2021 Dongsen | `src/main.ts`: one init import (observe-only) |
| `oss-solid-conduit` | https://github.com/solidjs/solid-realworld | `f6e77ecd652bf32f0dc9238f291313fd1af7e98b` | MIT (`package.json` "license": "MIT"; no separate licence file) | Ryan Carniato | `src/index.js`: one init import (observe-only); an `index.html` entry for Vite |
| `oss-mobx-conduit` | https://github.com/gothinkster/react-mobx-realworld-example-app | `c90ac8fa4b1f5c6292ca796b9c1a162efaef6e9b` | MIT (`LICENSE`) | Copyright (c) 2017 Thinkster | `src/index.js`: one init import (observe-only); a `tsconfig.json` (build config: legacy decorators, assignment-semantics class fields, `baseUrl: src`) so esbuild compiles what the app's babel setup compiled |
| `oss-vue2-conduit` | https://github.com/gothinkster/vue-realworld-example-app | `116b91944478860597b4fa2807ed99a2d873c734` (last Vue 2 commit) | MIT (`LICENSE`) | Copyright (c) 2017-present all contributors listed at https://github.com/gothinkster/vue-realworld-example-app/graphs/contributors | `src/main.js`: one init import (observe-only); built with Vite + @vitejs/plugin-vue2 (the repo's own toolchain); the theme stylesheet from the uninitialised `realworld` submodule is replaced by an empty module |
| `oss-angular-conduit` | https://github.com/gothinkster/angular-realworld-example-app | `dd99ed2cf39c805d719f943c5d7061a5683d98a8` | MIT (`LICENSE`) | Copyright (c) 2023 Thinkster | `src/main.ts`: one init import (observe-only); `angular.json` (build config): the init module external to the Angular build, no submodule styles/assets, no hashing/budgets/font inlining; output re-bundled into one module (`rebundle.mjs`) |
| `oss-elm-conduit` | https://github.com/rtfeldman/elm-spa-example | `cb32acd73c3d346d0064e7923049867d8ce67193` | MIT (`LICENSE`) | Copyright (c) 2017-2018 Richard Feldman and contributors | none to Elm code; a module entry `rw-main.js` = one init import + the compiled `elm.js` + index.html's inline bootstrap script, unchanged |
| `oss-svelte-conduit` | https://github.com/Leehuseung/realworld-svelte | `39402e919042a8b176209190b7c3385682848628` | MIT (`LICENSE`) | Copyright (c) 2021 RealWorld | `src/main.js`: one init import (observe-only); an `index.html` Vite entry; built with Vite + vite-plugin-svelte 2 (Svelte 3) applying the rollup config's production API-origin substitution |
| `oss-angularjs-conduit` | https://github.com/gothinkster/angularjs-realworld-example-app | `08755ca543e13cb26bc7086d0596ad58567a6f78` | MIT (`LICENSE`) | Copyright (c) 2022 Thinkster | `src/js/app.js`: one init import (observe-only); built like its gulpfile (templatecache, babel es2015, ng-annotate) by `build_angularjs.mjs`; AngularJS pinned to 1.5.11 (within the declared `^1.5.0-rc.2`) |
| `oss-wc-conduit` | https://github.com/gothinkster/web-components-realworld-example-app | `8408c72d1d62c4d67416b1d6b28d1deb6c521af9` | MIT (`package.json` "license": "MIT"; no separate licence file) | Admir Sabanovic (package.json author) | `app/index.js`: one init import (observe-only); `package.json`: the dead `git://` URL of @webcomponents/webcomponentsjs v1.0.0 replaced by the same version from npm; `util@0.11` added (webpack 4's Node polyfill that markdown-js relies on) |
| `oss-rescript-conduit` | https://github.com/jihchi/rescript-react-realworld-example-app | `bdd6fde5631a7e218251b49ebd061cbd7ba210b4` | MIT (`LICENSE.md`) | Copyright (c) 2020 Jihchi Lee | `src/main.res`: one `%%raw` init import (observe-only); compiled by the app's ReScript compiler, bundled by Vite |
| `oss-ember-conduit` | https://github.com/gothinkster/ember-realworld | `b7a8421b32384a0017dec30be28f4c3eaf74623a` | MIT (`package.json` "license": "MIT"; no separate licence file) | Alon Bukai and contributors (package.json) | none to app code (the init script is placed before the app's scripts); `ember-cli-build.js` (build config): ember-fetch `preferNative: true` |
| `oss-halogen-conduit` | https://github.com/thomashoneyman/purescript-halogen-realworld | `35f3d7363017fb3a2bd5fecfa1cba6d36f9b6211` | MIT (`LICENSE`) | Copyright (c) 2018 Thomas Honeyman | `index.js` (the JS entry): one init import (observe-only); compiled by spago/purs |

The mock backend for these apps (`src/world/ext/conduit.ts`) is written from the public RealWorld API spec
(https://realworld-docs.netlify.app/specifications/backend/endpoints/); no backend code is copied.

Toolchains fetched at prepare time for the open-source apps: the Elm 0.19.1 compiler binary (BSD-3-Clause,
github.com/elm/compiler releases), purs 0.15.15 (BSD-3-Clause, github.com/purescript/purescript releases) and spago
(BSD-3-Clause, npm); everything else comes from npm as each app's own (dev)dependencies.

Bundled framework and library dependencies of the apps written for the corpus (React, Redux Toolkit, Zustand,
TanStack Query, SWR, MobX, Vue, Pinia, Svelte, Solid, Preact, Lit, jQuery, Alpine, axios) are MIT-licensed npm
packages listed in `realapps/package.json`.
