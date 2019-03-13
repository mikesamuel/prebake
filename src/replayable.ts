/**
 * Keeps track of changes to an object graph so that it can later produce
 * code that will recreate the state of the object graph.
 */

//// Capture some state so this module continues to function even if polyfills do odd things
//// with builtins.
const globalObject: object =
      typeof global !== 'undefined' ? global :
      typeof window !== 'undefined' ? window :
      (() => { throw new Error() })();

const {
  setPrototypeOf: refSetPrototypeOf,
  preventExtensions: refPreventExtensions,
  get: refGet,
  set: refSet,
  deleteProperty: refDeleteProperty,
  defineProperty: refDefineProperty,
  apply: refApply,
  construct: refConstruct,
} = Reflect;

const error = console.error.bind(console);

const { getOwnPropertyDescriptor, getPrototypeOf } = Object;
const hasOwnProperty = Object.hasOwnProperty;


//// Side-step problems with user-code changing builtin prototypes
class ReliableWeakMap extends WeakMap {}
for (const key of (Object.getOwnPropertyNames(WeakMap.prototype) as Array<keyof WeakMap<any, any>>)) {
  ReliableWeakMap.prototype[key] = WeakMap.prototype[key];
}

class ReliableSet extends Set {}
for (const key of (Object.getOwnPropertyNames(Set.prototype) as Array<keyof Set<any>>)) {
  if (key !== 'size') {
    ReliableSet.prototype[key] = Set.prototype[key];
  }
}


// We break an object's history into a sequence of events.
// seq shows where that event occurs in a global ordering.
//
// We null out the prototype so that entries do not need to carry extra properties
// for us to be able to lookup properties on generic events without recourse to hasOwnProperty.
type ApplyEvent =
  { type: 'apply',
    seq: number, p?: null, x: Function, y?: null, z?: null,
    thisValue: any, args: any[], __proto__: null };
type ConstructEvent =
  { type: 'construct',
    seq: number, p?: null, x: new(...args:any[])=>any, y: any, z?: null,
    thisValue?: null, args: any[], __proto__: null };
type SetEvent =
  { type: 'set',
    seq: number, p: PropertyKey, x: object, y: any, z: object,
    thisValue?: null, args?: null, __proto__: null };
type DeleteEvent =
  { type: 'deleteProperty',
    seq: number, p: PropertyKey, x: object, y?: null, z?: null,
    thisValue?: null, args?: null, __proto__: null };
type GetEvent =
  { type: 'get',
    seq: number, p: PropertyKey, x: object, y: object, z?: null,
    thisValue?: null, args?: null, __proto__: null };
type DefineEvent =
  { type: 'defineProperty',
    seq: number, p: PropertyKey, x: object, y: PropertyDescriptor, z?: null,
    thisValue?: null, args?: null, __proto__: null };
type PreventExtensionsEvent =
  { type: 'preventExtensions',
    seq: number, p?: null, x: object, y?: null, z?: null,
    thisValue?: null, args?: null, __proto__: null };
type SetPrototypeOfEvent =
  { type: 'setPrototypeOf',
    seq: number, p?: null, x: object, y: object | null, z?: null,
    thisValue?: null, args?: null, __proto__: null };
type FunctionEvent =
  { type: 'function',
    seq: number, p?: null, x: string, y?: null, z?: null,
    thisValue: any, args: any[], freeNames: string[], __proto__: null };
type GetGlobalEvent =
  { type: 'getGlobal',
    seq: number, p?: null, x?: null, y?: null, z?: null,
    thisValue?: null, args?: null, __proto__: null };

/** The ways an object can come to exist. */
type Origin = ApplyEvent | ConstructEvent | FunctionEvent | GetGlobalEvent | GetEvent;
/** The ways an object can change. */
type Change = SetEvent | DeleteEvent | GetEvent | DefineEvent | PreventExtensionsEvent | SetPrototypeOfEvent;

type Event = Origin | Change;

/** Collects events related to one object. */
type History<T> = {
  proxy: T,          // A proxy over the object whose history this is that maintains changes.
  origin: Origin,    // How the object came to be
  changes: Change[], // Accumulates changes.
};

export class ObjectGraph {
  private objToHistory: WeakMap<object, History<object>>;
  private proxyToObj: WeakMap<object, object>;
  private proxyHandler: ProxyHandler<object>;
  private seq: number;

  constructor() {
    const self = this;
    this.objToHistory = new ReliableWeakMap();
    this.proxyToObj = new ReliableWeakMap();
    this.seq = 0;
    this.proxyHandler = {
      /*
      getPrototypeOf(target: object): object | null {
      },
      */
      setPrototypeOf(target: object, v: any): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null, type: 'setPrototypeOf', seq: self.seq++, x: target, y: v
          });
        return refSetPrototypeOf(target, v);
      },
      /*
      isExtensible(target: object): boolean {
      },
      */
      preventExtensions(target: object): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'preventExtensions', seq: self.seq++, x: target
          });
        return refPreventExtensions(target);
      },
      /*
      getOwnPropertyDescriptor(target: object, p: PropertyKey): PropertyDescriptor | undefined {
      },
      */
      /*
      has(target: object, p: PropertyKey): boolean {
      },
      */
      get(target: object, p: PropertyKey, receiver: any): any {
        let origin = null;
        if (target === globalObject) {
          origin = (seq: number):Origin => ({
            __proto__: null,
            type: 'get', seq, x: target, p, y: receiver
          });
        }

        for (let obj = target; obj; obj = getPrototypeOf(obj)) {
          const desc = getOwnPropertyDescriptor(obj, p);
          if (desc) {
            if (refApply(hasOwnProperty, desc, [ 'get' ])) {
              const history = self.objToHistory.get(target);
              if (!history) { throw new Error(); }
              history.changes.push({
                __proto__: null,
                type: 'get', seq: self.seq++, x: target, p, y: receiver
              });
            } else if (refApply(hasOwnProperty, desc, [ 'value' ])) {
              return self.getProxy(desc.value, origin);
            }
            break;
          }
        }

        return self.getProxy(refGet(target, p, receiver), origin);
      },
      set(target: object, p: PropertyKey, value: any, receiver: any): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'set', seq: self.seq++, x: target, p, y: value, z: receiver
          });
        return refSet(target, p, value, receiver);
      },
      deleteProperty(target: object, p: PropertyKey): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'deleteProperty', seq: self.seq++, x: target, p
          });
        return refDeleteProperty(target, p);
      },
      defineProperty(target: object, p: PropertyKey, attributes: PropertyDescriptor): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'defineProperty', seq: self.seq++, p, x: target, y: attributes
          });
        return refDefineProperty(target, p, attributes);
      },
      /*
      enumerate(target: object): PropertyKey[] {
      },
      */
      /*
      ownKeys(target: object): PropertyKey[] {
      },
      */
      apply(target: object, thisValue: any, argArray: any[]): any {
        const result = refApply(target as Function, thisValue, argArray);
        // Exceptions are special case wrapped in catch blocks.
        return self.getProxy(result, (seq: number) => ({
          __proto__: null,
          type: 'apply',
          seq,
          x: target as Function,
          thisValue,
          args: [...argArray],
        }));
      },
      construct(target: object, argArray: any[], newTarget?: any): object {
        const result = refConstruct(target as Function, argArray, newTarget);
        // Exceptions are special case wrapped in catch blocks.
        return self.getProxy(result, (seq: number) => ({
          __proto__: null,
          type: 'construct',
          seq,
          x: target as new(...args: any[])=>any,
          y: newTarget,
          args: [...argArray],
        }));
      },
    };
    // Make sure there's a reliable path to some core objects early in history.
    const globalProxy = this.getProxy(
      globalObject,
      (seq) => ({ __proto__: null, type: 'getGlobal', seq }));
    globalProxy.Object;
    globalProxy.Array;
    globalProxy.Function;
  }

  getProxy(x: any, origin?: null | ((seq: number) => Origin)):any {
    switch (typeof x) {
    case 'string': case 'number': case 'symbol': case 'boolean':
    case 'undefined':
      return x;
    case 'function':
    case 'object':
      if (x === null || this.proxyToObj.has(x)) {
        return x;
      }
      const obj = x as object;
      let history = this.objToHistory.get(obj);
      if (!history) {
        if (!origin) {
          error(`replayable: origin unavailable`);
          throw new Error('origin unavailable');
        }
        const proxy = new Proxy(obj, this.proxyHandler);
        history = {
          proxy,
          origin: origin(this.seq++),
          changes: []
        };
        this.objToHistory.set(obj, history);
        this.proxyToObj.set(proxy, obj);
      }
      return history.proxy;
    }
  }

  /** A proxy for the global object. */
  getGlobalProxy() {
    return this.getProxy(global);
  }

  /**
   * Returns the events necessary to recreate the given starting points.
   *
   * @param startingPoints the root objects to traverse from.
   */
  serializeHistories(startingPoints: object[]): Event[] {
    const events = [];
    const processed = new ReliableSet();
    let unprocessed = [...startingPoints];
    function maybeEnqueue(x: any) {
      if (x) {
        const to = typeof x;
        if (to === 'object' || to === 'function') {
          if (!processed.has(x)) {
            unprocessed.push(x);
          }
        }
      }
    }

    while (unprocessed.length) {
      const lastIndex = unprocessed.length - 1;
      const last = unprocessed[lastIndex];
      --unprocessed.length;
      if (processed.has(last)) {
        continue;
      }
      processed.add(last);
      const obj = this.proxyToObj.get(last);
      if (!obj) {
        continue;
      }
      const history = this.objToHistory.get(obj);
      if (!history) {
        continue;
      }
      const eventsLengthBefore = events.length;
      events.push(history.origin, ...history.changes);
      const eventsLengthAfter = events.length;
      for (let i = eventsLengthBefore; i < eventsLengthAfter; ++i) {
        const { x, y, z, thisValue, args } = events[i];
        maybeEnqueue(x);
        maybeEnqueue(y);
        maybeEnqueue(z);
        maybeEnqueue(thisValue);
        if (args) {
          for (const arg of args) {
            maybeEnqueue(arg);
          }
        }
      }
    }
    events.sort((a, b) => a.seq - b.seq);
    return events;
  }
}
