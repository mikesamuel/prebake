/**
 * @fileoverview
 * class ModuleSet makes it easy for processing stages to get modules
 * when they're ready.
 */

import { CanonModuleId, ModuleKey } from './module-id';
import { Module, ModuleKind, UnfetchedModule } from './module';
import { Fetcher } from './fetcher';

type ModuleSubtype = new (... args: any[]) => Module;

export class ModuleSet {
  private toNotifyOnPromotion: WeakMap<Module, Map<ModuleSubtype, Promise<Module>>> = new WeakMap();
  private idToModule: Map<ModuleKey, Module> = new Map();
  private loadOrder: CanonModuleId[] = [];
  private fetcher: Fetcher;
  private base: CanonModuleId;

  constructor(fetcher: Fetcher, base: CanonModuleId) {
    this.fetcher = fetcher;
    this.base = base;
    throw new Error('TODO' + this.toNotifyOnPromotion + this.idToModule + this.loadOrder + this.base + this.fetcher);
  }

  listen<T extends Module>(m: Module, subtype: new (...args: any[]) => T): Promise<T> {
    throw new Error('TODO' + m + subtype);
  }

  fetch(kind: ModuleKind, moduleIdStr: string, base: CanonModuleId | null): UnfetchedModule {
    throw new Error('TODO' + moduleIdStr + base + kind);
  }
}
