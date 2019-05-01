/**
 * Keeps track of changes to an object graph so that it can later produce
 * code that will recreate the state of the object graph.
 */

import { inspect } from 'util';

//// Capture some state so this module continues to function even if polyfills do odd things
//// with builtins.
const globalObject: object =
      typeof global !== 'undefined' ? global :
      typeof window !== 'undefined' ? window :
      (() => { throw new Error(); })();

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
  isArray,
} = Array;

const {
  create,
  defineProperties,
  getOwnPropertyDescriptor,
  getOwnPropertyNames,
  getPrototypeOf,
  hasOwnProperty,
} = Object;

const builtinObject = Object;
const builtinArray = Array;

const error = console.error.bind(console);

//// Side-step problems with user-code changing builtin prototypes
class ReliableWeakMap extends WeakMap {}
for (const key of (Object.getOwnPropertyNames(WeakMap.prototype) as (keyof WeakMap<any, any>)[])) {
  ReliableWeakMap.prototype[key] = WeakMap.prototype[key];
}

class ReliableSet extends Set {}
for (const key of (Object.getOwnPropertyNames(Set.prototype) as (keyof Set<any>)[])) {
  if (key !== 'size') {
    ReliableSet.prototype[key] = Set.prototype[key];
  }
}

const originalJSONParse = JSON.parse;
// JSON.parse is odd because it creates values out of whole cloth.
function replayableJSONParse(
  objectCtorProxy: new () => Object,
  arrayCtorProxy: new () => unknown[],
  createProxy: (proto: object | null) => Object,
  requireProxied: (x: object) => void) {
  return function parse(json: string, reviver?: (key: string, value: any) => any) {
    const parsed = originalJSONParse(json);

    function internalizeProperty(
        elementName: string, value: any, descriptorMap: PropertyDescriptorMap) {
      const proxiedValue = internalize(elementName, value);
      if (typeof proxiedValue !== 'undefined') {
        const proxiedDescriptor: PropertyDescriptor = createProxy(null);
        requireProxied(proxiedDescriptor);
        proxiedDescriptor.configurable = true;
        proxiedDescriptor.enumerable = true;
        proxiedDescriptor.writable = true;
        proxiedDescriptor.value = proxiedValue;
        requireProxied(proxiedValue);
        descriptorMap[elementName] = proxiedDescriptor;
      }
    }

    function internalize(name: string, element: any) {
      if (element && typeof element === 'object') {
        const descriptorMap = createProxy(null) as PropertyDescriptorMap;
        requireProxied(descriptorMap);

        let newElement;
        if (isArray(element)) {
          newElement = new arrayCtorProxy();
          requireProxied(newElement);
          for (let i = 0, n = element.length; i < n; ++i) {
            internalizeProperty('' + i, element[i], descriptorMap);
          }
        } else {
          newElement = new objectCtorProxy();
          requireProxied(newElement);
          for (const elementName of getOwnPropertyNames(element)) {
            internalizeProperty(elementName, element[elementName], descriptorMap);
          }
        }

        defineProperties(newElement, descriptorMap);
        element = newElement;
      }

      return typeof reviver === 'function'
          ? reviver(name, element) : element;
    }
    return internalize('', parsed);
  };
}

// We break an object's history into a sequence of events.
// seq shows where that event occurs in a global ordering.
//
// We null out the prototype so that entries do not need to carry extra properties
// for us to be able to lookup properties on generic events without recourse to hasOwnProperty.
interface ApplyEvent { type: 'apply';
    seq: number; p?: null; x: Function; y?: null; // z?: null,
    thisValue: any; args: any[]; desc?: null; __proto__: null; }
interface ConstructEvent { type: 'construct';
    seq: number; p?: null; x: new(...args: any[]) => any; y?: null; // z?: null,
    thisValue?: null; args: any[]; desc?: null; __proto__: null; }
interface SetEvent { type: 'set';
    seq: number; p: PropertyKey; x: object; y: any; // z?: null,
    thisValue?: null; args?: null; desc?: null; __proto__: null; }
interface DeleteEvent { type: 'deleteProperty';
    seq: number; p: PropertyKey; x: object; y?: null; // z?: null,
    thisValue?: null; args?: null; desc?: null; __proto__: null; }
interface GetEvent { type: 'get';
    seq: number; p: PropertyKey; x: object; y?: null; // z?: null,
    thisValue?: null; args?: null; desc?: null; __proto__: null; }
interface DefineEvent { type: 'defineProperty';
    seq: number; p: PropertyKey; x: object; y?: null; // z?: null,
    thisValue?: null; args?: null; desc: PropertyDescriptor; __proto__: null; }
interface PreventExtensionsEvent { type: 'preventExtensions';
    seq: number; p?: null; x: object; y?: null; // z?: null,
    thisValue?: null; args?: null; desc?: null; __proto__: null; }
interface SetPrototypeOfEvent { type: 'setPrototypeOf';
    seq: number; p?: null; x: object; y: object | null; // z?: null,
    thisValue?: null; args?: null; desc?: null; __proto__: null; }
interface GetGlobalEvent { type: 'getGlobal';
    seq: number; p?: null; x?: null; y?: null; // z?: null,
    thisValue?: null; args?: null; desc?: null; __proto__: null; }
interface CodeBindEvent { type: 'codeBind';
    seq: number; p?: null; x: any; y?: null; // z?: null,
    thisValue?: null; args?: object[]; desc?: null; __proto__: null; }
interface GetPrototypeOfEvent { type: 'getPrototypeOf';
    seq: number; p?: null; x: any; y?: null; // z?: null,
    thisValue?: null; args?: null; desc?: null; __proto__: null; }
interface GetOwnPropertyDescriptorEvent { type: 'getOwnPropertyDescriptor';
    seq: number; p: PropertyKey; x: any; y?: null; // z?: null,
    thisValue?: null; args?: null; desc?: null; __proto__: null; }

/** The ways an object can come to exist. */
type Origin = ApplyEvent | ConstructEvent | GetGlobalEvent | GetEvent | CodeBindEvent
            | GetPrototypeOfEvent | GetOwnPropertyDescriptorEvent;
/** The ways an object can change. */
type Change = SetEvent | DeleteEvent | GetEvent | DefineEvent | PreventExtensionsEvent | SetPrototypeOfEvent;

type Event = Origin | Change;

/** Collects events related to one object. */
interface History<T> {
  proxy: T;          // A proxy over the object whose history this is that maintains changes.
  origin: Origin;    // How the object came to be
  changes: Change[]; // Accumulates changes.
}

interface IndirectProxyTarget { target: object; }

export class ObjectGraph {
  /** Maps objects to their history. */
  private objToHistory: WeakMap<object, History<object>>;
  /** Maps proxies to the objects they proxy. */
  private proxyToObj: WeakMap<object, object>;
  /** The handler for newly created proxies. */
  private proxyHandler: ProxyHandler<IndirectProxyTarget>;
  /** A counter used to for new events' seq field. */
  private seq: number;
  debug = false;

  constructor() {
    const self = this;
    this.objToHistory = new ReliableWeakMap();
    this.proxyToObj = new ReliableWeakMap();
    this.seq = 0;

    // A generic proxy handler that works with all proxies created by getProxy.
    // We don't directly proxy objects because get traps for readonly properties
    // require returning the same value, so break proxying.
    this.proxyHandler = {
      getPrototypeOf({ target }: IndirectProxyTarget): object | null {
        return self.getProxy_(
          refGetPrototypeOf(target),
          (seq) => ({
            __proto__: null, type: 'getPrototypeOf', seq, x: target,
          }));
      },
      setPrototypeOf({ target }: IndirectProxyTarget, v: any): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null, type: 'setPrototypeOf', seq: self.seq++, x: target, y: v
          });
        return refSetPrototypeOf(target, v);
      },
      isExtensible({ target }: IndirectProxyTarget): boolean {
        return refIsExtensible(target);
      },
      preventExtensions({ target }: IndirectProxyTarget): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'preventExtensions', seq: self.seq++, x: target
          });
        return refPreventExtensions(target);
      },
      getOwnPropertyDescriptor({ target }: IndirectProxyTarget, p: PropertyKey)
      : PropertyDescriptor | undefined {
        return self.getProxy_(
          refGetOwnPropertyDescriptor(target, p),
          (seq) => ({
            __proto__: null, type: 'getOwnPropertyDescriptor', seq, x: target, p
          }));
      },
      has({ target }: IndirectProxyTarget, p: PropertyKey): boolean {
        return refHas(target, p);
      },
      get({ target }: IndirectProxyTarget, p: PropertyKey, receiver: any): any {
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
      set({ target }: IndirectProxyTarget, p: PropertyKey, value: any): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'set', seq: self.seq++, x: target, p, y: value, // z: receiver
          });
        return refSet(target, p, value);
      },
      deleteProperty({ target }: IndirectProxyTarget, p: PropertyKey): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'deleteProperty', seq: self.seq++, x: target, p
          });
        return refDeleteProperty(target, p);
      },
      defineProperty({ target }: IndirectProxyTarget, p: PropertyKey,
                     attributes: PropertyDescriptor): boolean {
        const history = self.objToHistory.get(target);
        if (!history) { throw new Error(); }
        history.changes.push(
          {
            __proto__: null,
            type: 'defineProperty', seq: self.seq++, p, x: target, desc: attributes
          });
        return refDefineProperty(target, p, attributes);
      },
      enumerate(/*{ target }: IndirectProxyTarget*/): PropertyKey[] {
        throw new Error('TODO');  // Is enumerate actually a thing?
      },
      ownKeys({ target }: IndirectProxyTarget): PropertyKey[] {
        return refOwnKeys(target);
      },
      apply({ target }: IndirectProxyTarget, thisValue: any, argArray: any[]): any {
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
      construct({ target }: IndirectProxyTarget, argArray: any[]/*, newTarget?: any*/): object {
        const result = refConstruct(target as Function, argArray);
        // Exceptions are special case wrapped in catch blocks so no need to proxy
        // them as they bubble out.
        return self.getProxy(result, (seq: number) => ({
          __proto__: null,
          type: 'construct',
          seq,
          x: target as new(...args: any[]) => any,
          args: [...argArray],
        }));
      },
    };
    // Make sure there's a reliable path to some core objects early in history.
    const globalProxy = this.getProxy(
      globalObject,
      (seq) => ({ __proto__: null, type: 'getGlobal', seq }));

    // Fetch some builtins for proxy trap side effect
    // tslint:disable-next-line:no-unused-expression
    globalProxy.Object;
    // tslint:disable-next-line:no-unused-expression
    globalProxy.Array;
    // tslint:disable-next-line:no-unused-expression
    globalProxy.Function;
    // tslint:disable-next-line:no-unused-expression
    globalProxy.Object.create;

    // JSON.parse is odd because it creates objects using non-proxyable internals.
    const jsonProxy = globalProxy.JSON;
    this.getProxy_(
      JSON.parse /* intentionally unproxied */,
      (seq: number, internalTarget: { target: object }): GetEvent => {
        // Sneakily replace the function that is actually called.
        internalTarget.target = replayableJSONParse(
          this.getProxy(builtinObject),
          this.getProxy(builtinArray),
          this.getProxy(create),
          (x: object) => {
            if (x && (typeof x === 'object' || typeof x === 'function')) {
              if (!this.proxyToObj.has(x)) {
                throw new Error('Unproxied');
              }
            }
          });
        return {
          __proto__: null,
          type: 'get', seq, x: jsonProxy, p: 'parse',
        };
      });
  }

  getProxy(x: any, origin?: null | ((seq: number) => Origin)): any {
    return this.getProxy_(x, origin);
  }

  private getProxy_(
    x: any,
    origin?: null | ((seq: number, internalTarget: { target: object }) => Origin)): any {

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
            // TODO: Distinguish between async and non-async.
            // tslint:disable-next-line
            xtype === 'function' ? function () {}
            : isArray(x) ? []
            : {};
        (indirectTargetInitial as IndirectProxyTarget).target = obj;
        const indirectTarget = (indirectTargetInitial as IndirectProxyTarget);

        const proxy = new Proxy(indirectTarget, this.proxyHandler);
        history = {
          proxy,
          origin: origin(this.seq++, indirectTarget),
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
    const unprocessed = [...startingPoints];
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
        try {
          console.log(inspect(last));
        } catch (ex) {
          console.log('not JSONable');
        }
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
        const { x, y, /*z,*/ thisValue, args, desc } = events[i];
        maybeEnqueue(x);
        maybeEnqueue(y);
        // maybeEnqueue(z);
        maybeEnqueue(thisValue);

        if (args) {
          for (const arg of args) {
            maybeEnqueue(arg);
          }
        }

        if (desc) {
          // Record is copied between property creation and proxy trap
          // TODO: Can we solve this in the proxy handler?
          if ('value' in desc) {
            maybeEnqueue(desc.value);
          } else {
            maybeEnqueue(desc.get);
            maybeEnqueue(desc.set);
          }
        }
      }
    }
    events.sort((a, b) => a.seq - b.seq);  // TODO: use builtin sort
    return events;
  }
}
