// Generated property setters for components whose inputs arrive as separate
// assignments (`list.items = …; list.areas = …`). Each setter stores its
// coerced value and schedules one render in a microtask, so a batch of
// assignments costs one render. `flushRender()` renders a pending batch now,
// for callers that need the DOM immediately (for example to restore focus).
// Not used by a component yet: refactor Slice 5 moves <kin-today> and others
// onto it. Until then those components guard their setters by identity
// themselves (COMPONENTS.md, "Incremental rendering").

const PENDING = Symbol("kinRenderPending");

/**
 * @param Class element class with a `render()` method
 * @param specs { name: { field, coerce } } — the setter stores
 *              `coerce(value, element)` in `this[field]` (default `_${name}`)
 */
export function defineProps(Class, specs) {
  for (const [name, spec] of Object.entries(specs)) {
    const field = spec.field ?? `_${name}`;
    const coerce = spec.coerce ?? ((value) => value);
    Object.defineProperty(Class.prototype, name, {
      configurable: true,
      enumerable: false,
      get() { return this[field]; },
      set(value) {
        this[field] = coerce(value, this);
        scheduleRender(this);
      },
    });
  }
  if (!Object.hasOwn(Class.prototype, "flushRender")) {
    Object.defineProperty(Class.prototype, "flushRender", {
      configurable: true,
      writable: true,
      value() {
        if (!this[PENDING]) return;
        this[PENDING] = false;
        this.render();
      },
    });
  }
}

/** Schedules one microtask render; repeated calls before it runs coalesce. */
export function scheduleRender(element) {
  if (element[PENDING]) return;
  element[PENDING] = true;
  queueMicrotask(() => element.flushRender());
}

export const asArray = (value) => (Array.isArray(value) ? value : []);
export const asFunction = (value) => (typeof value === "function" ? value : null);
