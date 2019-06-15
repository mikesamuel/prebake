import { cwd } from 'process';
import { realpathSync } from 'fs';
import { pathToFileURL } from 'url';

import { FetchContext, Fetcher } from './src/fetcher';
import { Module, RewrittenModule } from './src/module';
import { CanonModuleId, ModuleId, ModuleKey } from './src/module-id';
import { Cassandra } from './src/cassandra';
import { ModuleSet } from './src/module-set';
import { Gatherer } from './src/gatherer';
import { Rewriter } from './src/rewriter';

export interface PrebakeResult {
  modules: Map<ModuleKey, Module>;
  specifierToId: Map<string, ModuleId>;
}

export class Prebakery {
  // @ts-ignore unused
  private cassandra: Cassandra;
  private moduleSet: ModuleSet;
  // @ts-ignore unused
  private gatherer: Gatherer;
  // @ts-ignore unused
  private rewriter: Rewriter;
  private baseModuleId: CanonModuleId;

  constructor(fetcher: Fetcher, cassandra: Cassandra, baseModuleId: CanonModuleId | null = null) {
    this.cassandra = cassandra;
    if (!baseModuleId) {
      const dir = cwd();
      baseModuleId = new CanonModuleId(
        pathToFileURL(dir),
        pathToFileURL(realpathSync.native(dir)));
    }
    this.baseModuleId = baseModuleId;
    this.moduleSet = new ModuleSet();

    // Fetches new modules as needed.
    this.gatherer = new Gatherer(fetcher, this.cassandra, this.moduleSet);
    // Rewrites modules.
    this.rewriter = new Rewriter(this.moduleSet, this.cassandra);
  }

  /**
   * Given some starting module IDs, fetches them using a fetcher and returns a
   * promise to a map that maps the input module ids to prebaked modules.
   * The returned map will also include entries for any dependencies.
   */
  prebake(...moduleSpecifiers: string[]): Promise<PrebakeResult> {
    const fetchContext: FetchContext = {
      level: 'info',
      moduleId: this.baseModuleId,
      line: 1,
      message: 'Be awesome!',
    };
    const specifierToId: Map<string, ModuleId> = new Map();
    const resolutionPromises: Promise<Module>[] = [];
    for (const moduleSpecifier of moduleSpecifiers) {
      const p = this.moduleSet.fetch(moduleSpecifier, fetchContext);
      p.then((m: Module) => {
        specifierToId.set(moduleSpecifier, m.id);
      });
      resolutionPromises.push(p);
    }

    return new Promise((resolve: (r: PrebakeResult) => void) => {
      Promise.all(resolutionPromises).then(
        (resolvedModules: Module[]) => {
          const modules: Map<ModuleKey, Module> = new Map();

          const finishPromises = [];
          for (const m of resolvedModules) {
            if (m.errors && m.errors.length) {
              modules.set(m.id.key(), m);
            } else {
              finishPromises.push(
                this.moduleSet.onPromotionTo(m, RewrittenModule.prototype.constructor));
            }
          }

          Promise.all(finishPromises).then(
            (finishedModules: Module[]) => {
              for (const m of finishedModules) {
                modules.set(m.id.key(), m);
              }
              // TODO: transitive dependencies of rewritten modules.
              resolve({
                modules,
                specifierToId,
              });
            });
        },
        (err) => {
          // TODO
          console.error(err);
        });
    });
  }
}
