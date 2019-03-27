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
  defineProperty: refDefineProperty,
  deleteProperty: refDeleteProperty,
  apply: refApply,
  construct: refConstruct,
  get: refGet,
  getOwnPropertyDescriptor: refGetOwnPropertyDescriptor,
  getPrototypeOf: refGetPrototypeOf,
  has: refHas,
  isExtensible: refIsExtensible,
  ownKeys: refOwnKeys,
  preventExtensions: refPreventExtensions,
  set: refSet,
  setPrototypeOf: refSetPrototypeOf,
} = Reflect;

const {
  isArray
} = Array;

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
    seq: number, p?: null, x: Function, y?: null, //z?: null,
    thisValue: any, args: any[], __proto__: null };
type ConstructEvent =
  { type: 'construct',
    seq: number, p?: null, x: new(...args:any[])=>any, y?: null, //z?: null,
    thisValue?: null, args: any[], __proto__: null };
type SetEvent =
  { type: 'set',
    seq: number, p: PropertyKey, x: object, y: any, //z?: null,
    thisValue?: null, args?: null, __proto__: null };
type DeleteEvent =
  { type: 'deleteProperty',
    seq: number, p: PropertyKey, x: object, y?: null, //z?: null,
    thisValue?: null, args?: null, __proto__: null };
type GetEvent =
  { type: 'get',
    seq: number, p: PropertyKey, x: object, y?: null, //z?: null,
    thisValue?: null, args?: null, __proto__: null };
type DefineEvent =
  { type: 'defineProperty',
    seq: number, p: PropertyKey, x: object, y: PropertyDescriptor, //z?: null,
    thisValue?: null, args?: null, __proto__: null };
type PreventExtensionsEvent =
  { type: 'preventExtensions',
    seq: number, p?: null, x: object, y?: null, //z?: null,
    thisValue?: null, args?: null, __proto__: null };
type SetPrototypeOfEvent =
  { type: 'setPrototypeOf',
    seq: number, p?: null, x: object, y: object | null, //z?: null,
    thisValue?: null, args?: null, __proto__: null };
type GetGlobalEvent =
  { type: 'getGlobal',
    seq: number, p?: null, x?: null, y?: null, //z?: null,
    thisValue?: null, args?: null, __proto__: null };
type CodeBindEvent =
  { type: 'codeBind',
    seq: number, p?: null, x: any, y?: null, //z?: null,
    thisValue?: null, args?: object[], __proto__: null };

/** The ways an object can come to exist. */
type Origin = ApplyEvent | ConstructEvent | GetGlobalEvent | GetEvent | CodeBindEvent;
/** The ways an object can change. */
type Change = SetEvent | DeleteEvent | GetEvent | DefineEvent | PreventExtensionsEvent | SetPrototypeOfEvent;

type Event = Origin | Change;

/** Collects events related to one object. */
type History<T> = {
  proxy: T,          // A proxy over the object whose history this is that maintains changes.
  origin: Origin,    // How the object came to be
  changes: Change[], // Accumulates changes.
};

type indirectProxyTarget = { target: object }

export class ObjectGraph {
  /** Maps objects to their history. */
  private objToHistory: WeakMap<object, History<object>>;
  /** Maps proxies to the objects they proxy. */
  private proxyToObj: WeakMap<object, object>;
  /** The handler for newly created proxies. */
  private proxyHandler: ProxyHandler<indirectProxyTarget>;
  /** A counter used to for new events' seq field. */
  private seq: number;
  debug: boolean = false;

  constructor() {
    const self = this;
    this.objToHistory = new ReliableWeakMap();
    this.proxyToObj = new ReliableWeakMap();
    this.seq = 0;

    // A generic proxy handler that works with all proxies created by getProxy.
    // We don't directly proxy objects because get traps for readonly properties
    // require returning the same value, so break proxying.
    this.proxyHandler = {
      getPrototypeOf({ target }: indirectProxyTarget): object | null {
        return refGetPrototypeOf(target);
      },
      setPrototypeOf({ target }: indirectProxyTarget, v: any): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null, type: 'setPrototypeOf', seq: self.seq++, x: target, y: v
          });
        return refSetPrototypeOf(target, v);
      },
      isExtensible({ target }: indirectProxyTarget): boolean {
        return refIsExtensible(target);
      },
      preventExtensions({ target }: indirectProxyTarget): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'preventExtensions', seq: self.seq++, x: target
          });
        return refPreventExtensions(target);
      },
      getOwnPropertyDescriptor({ target }: indirectProxyTarget, p: PropertyKey)
      : PropertyDescriptor | undefined {
        return refGetOwnPropertyDescriptor(target, p);
      },
      has({ target }: indirectProxyTarget, p: PropertyKey): boolean {
        return refHas(target, p);
      },
      get({ target }: indirectProxyTarget, p: PropertyKey, receiver: any): any {
        for (let obj = target; obj; obj = getPrototypeOf(obj)) {
          const desc = getOwnPropertyDescriptor(obj, p);
          if (desc) {
            if (refApply(hasOwnProperty, desc, [ 'get' ])) {
              const history = self.objToHistory.get(target);
              if (!history) { throw new Error(); }
              history.changes.push({
                __proto__: null,
                type: 'get', seq: self.seq++, x: target, p, // y: receiver
              });
            } else if (refApply(hasOwnProperty, desc, [ 'value' ])) {
              const value = desc.value;
              return self.getProxy(
                value,
                (seq: number): Origin => ({
                  __proto__: null,
                  type: 'get', seq, x: target, p, // y: receiver
                }));
            }
            break;
          }
        }

        return self.getProxy(
          refGet(target, p, receiver),
          (seq: number): Origin => ({
            __proto__: null,
            type: 'get', seq, x: target, p, // y: receiver
          }));
      },
      set({ target }: indirectProxyTarget, p: PropertyKey, value: any): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'set', seq: self.seq++, x: target, p, y: value, // z: receiver
          });
        return refSet(target, p, value);
      },
      deleteProperty({ target }: indirectProxyTarget, p: PropertyKey): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'deleteProperty', seq: self.seq++, x: target, p
          });
        return refDeleteProperty(target, p);
      },
      defineProperty({ target }: indirectProxyTarget, p: PropertyKey, attributes: PropertyDescriptor): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'defineProperty', seq: self.seq++, p, x: target, y: attributes
          });
        return refDefineProperty(target, p, attributes);
      },
      enumerate(/*{ target }: indirectProxyTarget*/): PropertyKey[] {
        throw new Error('TODO');  // Is enumerate actually a thing?
      },
      ownKeys({ target }: indirectProxyTarget): PropertyKey[] {
        return refOwnKeys(target);
      },
      apply({ target }: indirectProxyTarget, thisValue: any, argArray: any[]): any {
        const result = refApply(target as Function, thisValue, argArray);
        // Exceptions are special case wrapped in catch blocks so no need to proxy
        // them as they bubble out.
        return self.getProxy(result, (seq: number) => ({
          __proto__: null,
          type: 'apply',
          seq,
          x: target as Function,
          thisValue,
          args: [...argArray],
        }));
      },
      construct({ target }: indirectProxyTarget, argArray: any[]/*, newTarget?: any*/): object {
        const result = refConstruct(target as Function, argArray);
        // Exceptions are special case wrapped in catch blocks so no need to proxy
        // them as they bubble out.
        return self.getProxy(result, (seq: number) => ({
          __proto__: null,
          type: 'construct',
          seq,
          x: target as new(...args: any[])=>any,
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
    const xtype = typeof x;
    switch (xtype) {
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
        if (this.debug) {
          console.log(`creating proxy for ${ obj }`);
        }
        if (!origin) {
          error(`replayable: origin unavailable`);
          throw new Error('origin unavailable');
        }

        // See proxyHandler comments above.
        const indirectTargetInitial: object =
            // TODO: Ideally indirectTarget would have [[Apply]] and [[Call]] only when x does.
            // TODO: Distinguish between function* and lambdas and regular functions.
            xtype === 'function' ? function () {}
            : isArray(x) ? []
            : {};
        (indirectTargetInitial as indirectProxyTarget).target = obj;
        const indirectTarget = (indirectTargetInitial as indirectProxyTarget);

        const proxy = new Proxy(indirectTarget, this.proxyHandler);
        history = {
          proxy,
          origin: origin(this.seq++),
          changes: [],
        };
        this.objToHistory.set(obj, history);
        this.proxyToObj.set(proxy, obj);
      }
      return history.proxy;
    }
  }

  unproxy<T extends object>(x: T): T {
    return (this.proxyToObj.get(x) as T) || x;
  }

  /** A proxy for the global object. */
  getGlobalProxy() {
    return this.getProxy(global);
  }

  /**
   * Creates a function, class, or lambda value given a functional proxy for source
   * code, a set of objects representing groups of free bindings in the same scope,
   * and a source handle that will allow a function equivalent to
   * builder to be reconstituted.
   *
   * For example,
   *   let f;
   *   {
   *     let x = 1;
   *     f = () => x++;
   *   }
   *
   * is equivalent to
   *
   *   let f;
   *   {
   *     let frame1 = { x: 1 };
   *     f = ((f1) => () => f1.x++)(frame1);
   *   }
   *
   * In the second decomposition, frame1 is a stack frame that may be shared
   * among multiple closures, and may have its own history in the object graph.
   *
   * The lambda ((f1) => () => ...) is a builder.
   *
   * Then, since builder has no free variables that are not globals,
   * its source code representation could be serialized as part of an event history
   * and reconstituted later.
   *
   * @param builder returns the declared result bound in the context of stack frames.
   * @param sourceHandle a value that is sufficient to reconstitute something equivalent
   *     to builder.
   *     This is stored with the origin event instead of builder because builder is opaque.
   *     Object graphs are agnostic to how sourceHandles are represented; the supplier of
   *     sourceHandles is responsible for supplying ones that are meaningful to eventual
   *     consumers of the serialized history.
   * @param stackFrames An array of stack frames from outermost scope to innermost.
   *     Own properties specify names that can be bound in the context of builder.
   * @return a proxy over the declared value.
   */
  declareFunction(builder: (...args: { [key: string]: any }[]) => Function,
                  sourceHandle: any,
                  stackFrames: { [key: string]: any }[]) {
    const stackFrameProxies: { [key: string]: any }[] = [];
    for (let i = 0, n = stackFrames.length; i < n; ++i) {
      stackFrameProxies[i] = this.getProxy(stackFrames[i]);
    }
    return this.getProxy(
      builder(...stackFrameProxies),
      (seq: number) => ({
        __proto__: null,
        seq,
        type: 'codeBind',
        x: sourceHandle,
        args: stackFrameProxies
      }));
  }

  /**
   * Returns the history for the given object.
   */
  getHistory<T extends object>(obj: T): (History<T> | null) {
    return (this.objToHistory.get(obj) as (History<T> | undefined)) || null;
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
      if (!(this.objToHistory.has(last) || this.proxyToObj.has(last))) {
        throw new Error(`unproxied ${ last }`);
      }
      const obj: object = this.proxyToObj.get(last) || last;
      if (processed.has(obj)) {
        continue;
      }
      processed.add(obj);
      const history = this.objToHistory.get(obj);
      if (!history) {
        continue;
      }
      const eventsLengthBefore = events.length;
      events.push(history.origin, ...history.changes);  // TODO: use builtin push
      const eventsLengthAfter = events.length;
      for (let i = eventsLengthBefore; i < eventsLengthAfter; ++i) {
        const { x, y, /*z,*/ thisValue, args } = events[i];
        maybeEnqueue(x);
        maybeEnqueue(y);
        //maybeEnqueue(z);
        maybeEnqueue(thisValue);
        if (args) {
          for (const arg of args) {
            maybeEnqueue(arg);
          }
        }
      }
    }
    events.sort((a, b) => a.seq - b.seq);  // TODO: use builtin sort
    return events;
  }
}
