// A runtime atom as a Lit reactive controller: the host re-renders whenever the atom changes
// (the Lit equivalent of useSyncExternalStore / a Svelte store subscription).
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { Atom } from "@genclass/runtime";

export class AtomController<T> implements ReactiveController {
  private off: (() => void) | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    readonly atom: Atom<T>,
  ) {
    host.addController(this);
  }

  get value(): T {
    return this.atom.get();
  }

  hostConnected(): void {
    this.off = this.atom.subscribe(() => this.host.requestUpdate());
  }

  hostDisconnected(): void {
    this.off?.();
    this.off = null;
  }
}
