/**
 * @fileoverview
 * class ModuleSet makes it easy for processing stages to get modules
 * when they're ready.
 *
 * This is structured as a message bus to avoid tight coupling between
 * pipeline stages.
 *
 * Since all callbacks fire when a principal is found to have an error,
 * it should be easy for stages to know when to stop waiting.
 */

import { Cassandra } from './cassandra';
import { FetchContext } from './fetcher';
import {
  CanonModule, ErrorModule, Module, ResolvedModule, UnresolvedModule,
  ModuleError, ModuleSubtype, compareModuleStage,
} from './module';
import { ModuleId, ModuleKey, TentativeModuleId } from './module-id';
import { resolve } from './node-modules';

/** Separable handles to a promise and a function that will cause it to resolve. */
interface Resolvable<T> {
  promise: Promise<T>;
  resolveTo(x: T): void;
}

function createResolvable<T>(): Resolvable<T> {
  let resolveTo: (x: T) => void = () => {
    // There isn't actually a race condition here since
    // Promise calls its argument eagerly, but initializing avoids a
    // typescript compiler warning.
    throw new Error('uninitialized');
  };
  const promise = new Promise<T>((resolve) => {
    resolveTo = resolve;
  });
  return { promise, resolveTo };
}


/**
 * A set of modules.
 */
export class ModuleSet {
  private cassandra: Cassandra;
  /** Maps string forms of module ids to module. */
  private idToModule: Map<ModuleKey, Module> = new Map();
  /**
   * Promises to complete when a module reaches a particular stage.
   * The contents are not actually Promise<Module>s; the inner maps have entries of the form
   * [module type K, Promise<K | ErrorModule>].
   *
   * The keys should be a subset of idToModule's values.
   */
  private toNotifyOnPromotion: WeakMap<Module, Map<ModuleSubtype<Module>, Resolvable<Module>>> =
    new WeakMap();
  /** Called when an unseen tentative module id enters idToModule. */
  private promotionCallbacks: Map<ModuleSubtype<Module>, ((m: Module) => void)[]> = new Map();

  constructor(cassandra: Cassandra) {
    this.cassandra = cassandra;
  }

  /** The module identified by the given ID if any. */
  get(moduleId: ModuleId): Module | null {
    const moduleKey = moduleId.key();
    return this.idToModule.get(moduleKey) || null;
  }

  /**
   * Updates the module set to include the given module.
   * If an existing module shares a module ID with newModule then it will be replaced unless
   * doing so would cause a transition from an error state to a non-error state, or a transition
   * from a canonical state to a newly fetched or resolved state.
   *
   * If newModule's id has a canonical URL, then any update will affect both the absolute and
   * canonical ids.
   */
  set(newModule: Module): Module {
    // We need to preserve several properties.
    // 1. No module transitions out of ErrorModule
    // 2. A module at a later stage doesn't clobber an one at an earlier stage.
    // 3. All other sets take effect.
    // 4. New modules are broadcast to onNewModule callbacks
    // 5. When a canonical module is promoted to a canonical module, onResolution callbacks fire.
    // 6. When a tentative module id is resolved to a canonical ID, onResolution callbacks fire.
    // 7. When a module resolves to or is promoted to an error module, all its onResolution
    //    callbacks fire.

    const unresolvedKey: ModuleKey = JSON.stringify({
      target: newModule.id.abs.href,
      source: newModule.metadata.base.canon.href,
    });
    const resolvedKey: ModuleKey | null = newModule.id.canon ? newModule.id.canon.href : null;

    let finalModule: Module;

    const oldUnresolvedModule = this.idToModule.get(unresolvedKey) || null;
    const oldResolvedModule = resolvedKey ? (this.idToModule.get(resolvedKey) || null) : null;

    // Preserve property 1
    if (oldResolvedModule instanceof ErrorModule) {
      oldResolvedModule.maybeMergeErrors(newModule, oldUnresolvedModule);
      finalModule = oldResolvedModule;
    } else if (oldUnresolvedModule instanceof ErrorModule) {
      oldUnresolvedModule.maybeMergeErrors(newModule);
      finalModule = oldUnresolvedModule;
    } else if (newModule instanceof ErrorModule) {
      finalModule = newModule;
    } else {
      // Preserve property 2
      if (oldResolvedModule && compareModuleStage(newModule, oldResolvedModule) <= 0) {
        finalModule = oldResolvedModule;
      } else if (oldUnresolvedModule && compareModuleStage(newModule, oldUnresolvedModule) <= 0) {
        finalModule = oldUnresolvedModule;
      } else {
        // Preserve property 3
        finalModule = newModule;
      }
    }

    if (resolvedKey !== null) {
      this.idToModule.set(resolvedKey, finalModule);
    }
    this.idToModule.set(unresolvedKey, finalModule);

    if (finalModule === newModule) {
      // Preserve property 4
      (<T extends Module>(m: T) => {
        const subtype: ModuleSubtype<T> = m.constructor;
        for (const callback of this.getPromotionCallbacks(subtype)) {
          try {
            callback(m);
          } catch (e) {
            console.error(`Dispatch to callback failed`, e);
          }
        }
      })(newModule);
    }

    if (finalModule.id.canon || finalModule instanceof ErrorModule) {
      const targetModule = finalModule as (CanonModule | ErrorModule);
      if (oldUnresolvedModule) {
        // Preserve property 5
        this.dispatchNotifications_(oldUnresolvedModule, targetModule);
      }

      if (oldResolvedModule) {
        // Preserve property 6
        this.dispatchNotifications_(oldResolvedModule, targetModule);
      }
    }

    return finalModule;
  }

  private dispatchNotifications_(oldModule: Module, newModule: (ErrorModule | CanonModule)) {
    const typeToPromiseMap = this.toNotifyOnPromotion.get(oldModule);
    this.toNotifyOnPromotion.delete(oldModule);
    if (typeToPromiseMap) {
      if (newModule instanceof ErrorModule) {
        // Preserve property 7
        for (const [, { resolveTo }] of typeToPromiseMap) {
          resolveTo(newModule);
        }
      } else {
        this.toNotifyOnPromotion.set(newModule, typeToPromiseMap);
        const subtype: ModuleSubtype<ErrorModule | CanonModule> = newModule.constructor;
        const resolvable = typeToPromiseMap.get(subtype);
        typeToPromiseMap.delete(subtype);
        if (resolvable) {
          resolvable.resolveTo(newModule);
        }
      }
    }
  }

  /** Registers a callback to be notified when a new, unresolved module enters the pipeline. */
  onNewModule(cb: (m: UnresolvedModule) => void): void {
    this.onAnyPromotedTo(cb, UnresolvedModule.prototype.constructor);
  }

  private getPromotionCallbacks<T extends Module>(subtype: ModuleSubtype<T>): ((m: T) => void)[] {
    const callbackList = this.promotionCallbacks.get(subtype) || [];
    if (!callbackList.length) {
      this.promotionCallbacks.set(subtype, callbackList);
    }
    return callbackList as ((m: T) => void)[];
  }

  /** Registers a callback to be notified when a new, unresolved module enters the pipeline. */
  onAnyPromotedTo<T extends Module>(cb: (m: T) => void, subtype: ModuleSubtype<T>): void {
    this.getPromotionCallbacks(subtype).push(cb);
  }

  /** A promise that resolves when the given module is resolved or transitions to an error. */
  onResolution(m: UnresolvedModule): Promise<ResolvedModule | ErrorModule> {
    return this.onPromotionTo(m, ResolvedModule.prototype.constructor);
  }

  /**
   * A promise that resolves when the given module is promoted to the given type or
   * transitions to an error.
   */
  onPromotionTo<T extends CanonModule>(m: Module, subtype: ModuleSubtype<T>):
      Promise<T | ErrorModule> {
    if (m instanceof ErrorModule || m instanceof subtype) {
      // Error modules do not make progress, and a module
      // that has already reached the given stage will not
      // progress back to that stage since progression is monotonic.
      return Promise.resolve(m);
    }

    if (compareModuleStage(m, subtype) > 0) {
      throw new Error(`Module ${ m.id } already passed stage ${ subtype.name }`);
    }

    let typeMap = this.toNotifyOnPromotion.get(m);
    if (!typeMap) {
      typeMap = new Map();
      this.toNotifyOnPromotion.set(m, typeMap);
    }
    let resolvable = typeMap.get(subtype);
    if (!resolvable) {
      resolvable = createResolvable<T>();
      typeMap.set(subtype, resolvable);
    }
    return resolvable.promise as Promise<T | ErrorModule>;
  }

  /**
   * Creates a new module which the gatherer will normally look for.
   */
  async fetch(moduleIdStr: string, context: FetchContext): Promise<Module> {
    const base = context.moduleId;
    let absUrl = null;
    let failure = null;
    try {
      absUrl = await resolve(moduleIdStr, base.abs);
    } catch (exc) {
      failure = exc;
    }
    if (absUrl === null) {
      const error: ModuleError = {
        level: 'error',
        moduleId: base,
        line: context.line,
        message: failure
          ? failure.message
          : `Failed to resolve module ${ moduleIdStr } relative to ${ base.abs.href }`
      };
      this.cassandra(error);
      const errorModule = new ErrorModule(
        new UnresolvedModule(
          new TentativeModuleId(new URL(
            `invalid-id:${ encodeURIComponent(moduleIdStr) }`)),
          context),
        [ error ]);
      return this.set(errorModule);
    } else {
      const tentativeId: TentativeModuleId = new TentativeModuleId(absUrl);
      const unresolvedModule = new UnresolvedModule(tentativeId, context);
      return this.set(unresolvedModule);
    }
  }
}
