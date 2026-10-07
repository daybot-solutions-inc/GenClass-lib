import type { FeatureDef } from "../feature.js";
import { auth } from "./auth.js";
import { benign } from "./benign.js";
import { board } from "./board.js";
import { bulk } from "./bulk.js";
import { cart } from "./cart.js";
import { chat } from "./chat.js";
import { counter } from "./counter.js";
import { editor } from "./editor.js";
import { form } from "./form.js";
import { list } from "./list.js";
import { nav } from "./nav.js";
import { poll } from "./poll.js";
import { search } from "./search.js";
import { settings } from "./settings.js";
import { toggle } from "./toggle.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const FEATURES: Record<string, FeatureDef<any>> = {
  search, editor, form, cart, toggle, counter, poll, board, chat, settings, nav, list, bulk, auth, benign,
};

/** Relative frequency of each feature kind in generated programs. */
export const FEATURE_WEIGHTS: Record<string, number> = {
  search: 10, editor: 9, form: 8, cart: 8, toggle: 6, counter: 5, poll: 9, board: 7, chat: 6, settings: 5, nav: 7, list: 7, bulk: 4, auth: 3, benign: 4,
};
