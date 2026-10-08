import type { FeatureDef } from "../feature.js";
import { auth } from "./auth.js";
import { badge } from "./badge.js";
import { benign } from "./benign.js";
import { board } from "./board.js";
import { bulk } from "./bulk.js";
import { cart } from "./cart.js";
import { cascade } from "./cascade.js";
import { chat } from "./chat.js";
import { clockskew } from "./clockskew.js";
import { counter } from "./counter.js";
import { editor } from "./editor.js";
import { etag } from "./etag.js";
import { exportjob } from "./exportjob.js";
import { facets } from "./facets.js";
import { form } from "./form.js";
import { graphql } from "./graphql.js";
import { infinite } from "./infinite.js";
import { inventory } from "./inventory.js";
import { list } from "./list.js";
import { longtask } from "./longtask.js";
import { masterdetail } from "./masterdetail.js";
import { multitab } from "./multitab.js";
import { nav } from "./nav.js";
import { offline } from "./offline.js";
import { payment } from "./payment.js";
import { poll } from "./poll.js";
import { prefetch } from "./prefetch.js";
import { presence } from "./presence.js";
import { querycache } from "./querycache.js";
import { reorder } from "./reorder.js";
import { saga } from "./saga.js";
import { search } from "./search.js";
import { settings } from "./settings.js";
import { toggle } from "./toggle.js";
import { undo } from "./undo.js";
import { upload } from "./upload.js";
import { wizard } from "./wizard.js";
import { wsreconnect } from "./wsreconnect.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const FEATURES: Record<string, FeatureDef<any>> = {
  // round 1
  search, editor, form, cart, toggle, counter, poll, board, chat, settings, nav, list, bulk, auth, benign,
  // round 2
  infinite, upload, offline, wsreconnect, undo, reorder, querycache,
  graphql, saga, wizard, etag, presence, badge, facets, masterdetail,
  clockskew, longtask, cascade, exportjob, payment, inventory, prefetch, multitab,
};

/** Relative frequency of each feature kind in generated programs. */
export const FEATURE_WEIGHTS: Record<string, number> = {
  search: 8, editor: 7, form: 7, cart: 7, toggle: 5, counter: 4, poll: 7, board: 6, chat: 5, settings: 4, nav: 6, list: 6, bulk: 4, auth: 4, benign: 4,
  infinite: 5, upload: 4, offline: 5, wsreconnect: 5, undo: 5, reorder: 5, querycache: 6,
  graphql: 4, saga: 4, wizard: 5, etag: 5, presence: 4, badge: 5, facets: 5, masterdetail: 6,
  clockskew: 4, longtask: 4, cascade: 5, exportjob: 4, payment: 5, inventory: 5, prefetch: 4, multitab: 5,
};
