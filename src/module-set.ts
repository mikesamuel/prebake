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

import { CanonModuleId, ModuleId, ModuleKey } from './module-id';
import {
  CanonModule, ErrorModule, Module,
  ModuleKind, ResolvedModule, UnresolvedModule,
} from './module';
import { Fetcher } from './fetcher';

type ModuleSubtype = new (... args: any[]) => Module;

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
  /** Maps string forms of module ids to module. */
  private idToModule: Map<ModuleKey, Module> = new Map();
  /**
   * Promises to complete when a module reaches a particular stage.
   * The contents are not actually Promise<Module>s; the inner maps have entries of the form
   * [module type K, Promise<K | ErrorModule>].
   *
   * The keys should be a subset of idToModule's values.
   */
  private toNotifyOnPromotion: WeakMap<Module, Map<ModuleSubtype, Resolvable<Module>>> =
    new WeakMap();
  /** Called when an unseen tentative module id enters idToModule. */
  private newModuleCallbacks: ((m: UnresolvedModule) => void)[] = [];
  private loadOrder: Promise<CanonModuleId>[] = [];
  private fetcher: Fetcher;
  private base: CanonModuleId;

  constructor(fetcher: Fetcher, base: CanonModuleId) {
    this.fetcher = fetcher;
    this.base = base;
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
    // 2. When newModule is a ResolvedModule, it doesn't clobber an aliased canon module.
    // 3. All other sets take effect.
    // 4. When a canonical module is promoted to a canonical module, onResolution callbacks fire.
    // 5. When a tentative module id is resolved to a canonical ID, onResolution callbacks fire.
    // 6. When a module resolves to or is promoted to an error module, all its onResolution
    //    callbacks.
    // 7. New modules are broadcast to onNewModule callbacks
    const unresolvedKey: ModuleKey = newModule.id.abs.href;
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
    } else if (newModule instanceof ResolvedModule && oldResolvedModule) {
      // Preserve property 2
      finalModule = oldResolvedModule;
    } else {
      // Preserve property 3
      finalModule = newModule;
    }

    if (resolvedKey) {
      this.idToModule.set(resolvedKey, finalModule);
    }
    this.idToModule.set(unresolvedKey, finalModule);

    if (finalModule === newModule) {
      if (oldUnresolvedModule) {
        let oldModule: Module;
        if (oldUnresolvedModule.id.canon) {
          // Preserve property 4
          if (!oldResolvedModule) {
            throw new Error('old module is canon but not present by that name');
          }
          oldModule = oldResolvedModule as CanonModule;
        } else {
          // Preserve property 5
          oldModule = oldUnresolvedModule;
        }
        const typeToPromiseMap = this.toNotifyOnPromotion.get(oldModule);
        this.toNotifyOnPromotion.delete(oldModule);
        if (typeToPromiseMap) {
          // Preserve property 6
          if (finalModule instanceof ErrorModule) {
            for (const [, { resolveTo }] of typeToPromiseMap) {
              resolveTo(finalModule);
            }
          } else {
            this.toNotifyOnPromotion.set(finalModule, typeToPromiseMap);
            const typeKey = newModule.constructor as ModuleSubtype;
            const resolvable = typeToPromiseMap.get(typeKey);
            typeToPromiseMap.delete(typeKey);
            if (resolvable) {
              resolvable.resolveTo(finalModule);
            }
          }
        }
      } else if (newModule instanceof UnresolvedModule) {
        // Preserve property 7
        for (const newModuleCallback of this.newModuleCallbacks) {
          try {
            newModuleCallback(newModule);
          } catch (e) {
            console.error(`Dispatch to callback failed`, e);
          }
        }
      }
    }

    return finalModule;
  }

  /** Registers a callback to be notified when a new, unresolved module enters the pipeline. */
  onNewModule(cb: (m: UnresolvedModule) => void): void {
    this.newModuleCallbacks.push(cb);
  }

  /** A promise that resolves when the given module is resolved or transitions to an error. */
  onResolution(m: UnresolvedModule): Promise<ResolvedModule | ErrorModule> {
    return this.onPromotionTo(m, ResolvedModule);
  }

  /**
   * A promise that resolves when the given module is promoted to the given type or
   * transitions to an error.
   */
  onPromotionTo<T extends CanonModule>(m: Module, subtype: new (...args: any[]) => T):
      Promise<T | ErrorModule> {
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

  fetch(kind: ModuleKind, moduleIdStr: string, base: CanonModuleId | null): UnresolvedModule {
    throw new Error('TODO' + moduleIdStr + base + kind + this.fetcher + this.loadOrder + this.base);
  }
}
