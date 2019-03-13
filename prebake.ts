import * as fs from 'fs';
import * as path from 'path';
import * as timers from 'timers';
import { URL } from 'url';
import {
  BabelFileResult,
  Node,
  ParseResult,
  parseSync,
  transformFromAstSync,
} from '@babel/core';

export type ModuleId = URL;
export type ModuleKey = string;

export interface FetchResult {
  moduleSource: string | null;
  canonicalModuleId: ModuleId;
  error: string | null;
  failover: boolean;
}

export type Fetcher = (moduleId : ModuleId, loader: ModuleId | null) => Promise<FetchResult>;

/** Given a root directory, returns a fetcher. */
export function fileSystemFetcher(root: string) : Fetcher {
  return (moduleId : ModuleId) => {
    if (moduleId.protocol && moduleId.protocol.toLowerCase() === 'file:') {
      let { pathname } = moduleId;
      pathname = pathname.split('/').map(decodeURIComponent).join(path.sep);
      let canonUrl = path.resolve(root, pathname)
          .split(path.sep)
          .map(encodeURIComponent)
          .join('/');
      if (!(canonUrl && canonUrl[0] === '/')) {
        canonUrl = `/${ canonUrl }`;
      }
      canonUrl = `file://${ canonUrl }`;
      const canonicalModuleId = new URL(canonUrl);

      return new Promise(
        (resolve) => {
          console.log('about to read');
          fs.readFile(pathname, { encoding: 'UTF-8' }, (error, data) => {
            if (error) {
              resolve({
                moduleSource: null,
                canonicalModuleId,
                error: error.toString(),
                failover: false,
              });
            } else {
              resolve({
                moduleSource: data,
                canonicalModuleId,
                error: null,
                failover: false,
              });
            }
          });
        });
    }

    return Promise.resolve({
      moduleSource: null,
      canonicalModuleId: moduleId,
      error: `Expected file: URL not ${ moduleId }`,
      failover: true,
    });
  };
}

export class PrebakedModule {
  moduleId: ModuleId;
  dependencies: PrebakedModule[] = [];
  error: string | null;
  rawSource: string | null;
  bakedSource: string | null = null;
  sourceMap: string | null = null;

  get moduleKey() { return String(this.moduleId.href); }

  constructor(moduleId : ModuleId, rawSource: string | null, error: string | null) {
    this.moduleId = moduleId;
    this.rawSource = rawSource;
    this.error = error;
  }
}

type CycleAvoidance = ModuleKey[];

interface Job {
  moduleKey: ModuleKey;
  module: PrebakedModule;
  cycleAvoidance: CycleAvoidance;
  ast?: ParseResult;
}

export class Prebakery {
  private fetcher : Fetcher;
  /** Maps the string form of module IDs to */
  private moduleKeyToModule: Map<ModuleKey, PrebakedModule> = new Map();
  /** Set of the string forms of canonical moduleIds of modules that are complete. */
  private completed: Set<string> = new Set();
  private pending: Job[] = [];
  /**
   * Maps the string forms of canonical moduleIds to resolver functions that should
   * be called when that module id is finished.
   */
  private waiting: Map<ModuleKey, ((complete: PrebakedModule) => any)[]> = new Map();
  /** Interval ID of a task that consumes the pending queue. */
  private processing : boolean = false;

  constructor(fetcher : Fetcher) {
    this.fetcher = fetcher;
  }

  /**
   * Given some starting module IDs, fetches them using a fetcher and returns a
   * promise to a map that maps the input module ids to prebaked modules.
   * The returned map will also include entries for any dependencies.
   */
  prebake(...moduleIds : ModuleId[]) : Promise<Map<ModuleKey, PrebakedModule>> {
    return this._prebake(moduleIds, null, []);
  }

  _prebake(
    moduleIds: ModuleId[], requester: ModuleId|null,
    cycleAvoidance: CycleAvoidance)
  : Promise<Map<ModuleKey, PrebakedModule>> {
    const promises : Promise<PrebakedModule>[] = [];
    for (const id of moduleIds) {
      const promise : Promise<PrebakedModule> = new Promise(
        (resolve) => {
          this._fetch(id, requester).then(
            ({ canonicalModuleId, moduleSource, error } : FetchResult) => {
              console.log('Got fetch result');
              const moduleKey = String(canonicalModuleId.href);
              canonicalModuleId = Object.freeze(new URL(moduleKey));
              const waiterQueue = this.waiting.get(moduleKey);
              if (waiterQueue) {
                if (cycleAvoidance.indexOf(moduleKey) >= 0) {
                  // TODO resolve({  });
                  throw new Error('IMPLEMENT ME');
                  return;
                }
                waiterQueue.push(resolve);
              } else {
                const module = new PrebakedModule(canonicalModuleId, moduleSource, error);
                this.moduleKeyToModule.set(moduleKey, module);
                this.waiting.set(moduleKey, [ resolve ]);
                this.pending.push(Object.assign(Object.create(null), { moduleKey, module }));
                console.log('prodding');
                this._prod();
              }
            },
            (err) => {
              const canonId = Object.freeze(new URL(String(id.href)));
              resolve(new PrebakedModule(canonId, null, err.toString() || 'Fetch failed'));
            }
          );
        }
      );
      promises.push(promise);
    }

    return new Promise(
      (resolve, reject) => {
        Promise.all(promises).then(
          (modules : Iterable<PrebakedModule>) => {
            const moduleArr : PrebakedModule[] = Array.from(modules);
            const map : Map<ModuleKey, PrebakedModule> = new Map();
            const seen : Set<PrebakedModule> = new Set();

            function putModuleAndDeps(module : PrebakedModule) {
              const { moduleKey } = module;
              if (!map.has(moduleKey)) {
                map.set(moduleKey, module);
              }
              if (!seen.has(module)) {
                seen.add(module);
                for (const dep of module.dependencies) {
                  putModuleAndDeps(dep);
                }
              }
            }

            for (let i = 0, n = moduleArr.length; i < n; ++i) {
              const key = String(moduleIds[i].href);
              const module = moduleArr[i];
              map.set(key, module);
            }
            for (const module of modules) {
              putModuleAndDeps(module);
            }
            resolve(map);
          },
          (err : Error) => { reject(err); }
        );
      }
    );
  }

  private _fetch(requested: ModuleId, requester: ModuleId | null): Promise<FetchResult> {
    return this.fetcher(requested, requester);
  }

  private _prod() {
    if (!this.processing) {
      this.processing = true;
      const processorJob = timers.setInterval(
        () => {
          if (this.pending.length) {
            this._parse((<Job>this.pending.shift()));
          } else {
            this.processing = false;
            clearInterval(processorJob);
          }
        },
        0);
    }
  }

  private _parse(job: Job) {
    let error: string | null = job.module.error;
    if (error === null && job.module.rawSource === null) {
      error = `Source unavailable for ${ job.moduleKey }`;
    }
    let ast: ParseResult | null = null;
    if (error === null) {
      try {
        ast = parseSync(
          (<string>job.module.rawSource),
          {
            filename: job.moduleKey,
            sourceType: 'unambiguous'
          });
        if (!ast) {
          error = `Parse failed for ${ job.moduleKey }`;
        }
      } catch (err) {
        error = String(err);
      }
    }
    if (error !== null) {
      job.module.error = error;
      this._complete(job);
    } else {
      job.ast = (<ParseResult>ast);
      this._process(job);
    }
  }

  private _process(job: Job) {
    const { module, ast } = job;
    if (!ast) { throw new Error(); }

    this._rewrite(module, ast, job.cycleAvoidance).then(
      () => {
        const fileResult: BabelFileResult | null = transformFromAstSync(
          ast, undefined,
          {
            code: true,
            sourceMaps: true,
            sourceFileName: module.moduleKey
          });
        if (fileResult) {
          const { code, map } = fileResult;
          module.bakedSource = code || '';
          module.sourceMap = map ? JSON.stringify(map) : null;
        } else {
          module.error = module.error || 'Failed to serialize AST';
        }
        this._complete(job);
      },
      (error) => {
        module.error = module.error || String(error);
        this._complete(job);
      });
  }

  private _complete({ moduleKey, module }: Job) {
    this.completed.add(moduleKey);
    const waiters = this.waiting.get(moduleKey);
    this.waiting.delete(moduleKey);
    if (waiters) {
      for (const waiter of waiters) {
        setTimeout(
          () => waiter(module),
          0);
      }
    }
  }

  private _prefetchDependencies(moduleId: ModuleId, ast: Node): ModuleId[] {
    // Look for { "type": "ImportDeclaration", "source": { value } }
    const descendInto: Set<String> = new Set(['File', 'Program']);
    const dependencies: ModuleId[] = [];
    function walk(ast: Node) {
      if (ast.type === 'ImportDeclaration') {
        const importDecl = ast;
        let relPath = importDecl.source.value;
        if (!/\.\w+$/.test(relPath)) {
          relPath += '.js';
        }
        const depModuleId = new URL(relPath, moduleId);
        dependencies.push(depModuleId);
      } else if (descendInto.has(ast.type)) {
        for (const key of Object.getOwnPropertyNames(ast)) {
          const value: any = (<{ [key: string]: any }>ast)[key];
          if (value && typeof value === 'object' && typeof value.type === 'string') {
            walk(value);
          } else if (Array.isArray(value)) {
            const arr: any[] = (<any[]>value);
            for (const el of arr) {
              if (el && typeof el === 'object' && typeof el.type === 'string') {
                walk(el);
              }
            }
          }
        }
      }
    }
    walk(ast);
    return dependencies;
  }

  private _rewrite(module: PrebakedModule, ast: ParseResult, cycleAvoidance: CycleAvoidance) {
    const { moduleId, moduleKey } = module;

    return new Promise((resolve) => {
      const dependencies = this._prefetchDependencies(moduleId, ast);
      this._prebake(dependencies, moduleId, cycleAvoidance).then(
        (moduleMap) => {
          const modulesSeen: Set<PrebakedModule> = new Set();
          for (const dep of moduleMap.values()) {
            if (!modulesSeen.has(dep)) {
              modulesSeen.add(dep);
              module.dependencies.push(dep);
              console.log('adding ' + dep.moduleId + ' as a dependency of ' + module.moduleId);
            }
          }
          console.log(`moduleKey=${ moduleKey }, ast=\n${ JSON.stringify(ast, null, 2) }\ndependencies=${ dependencies }`);
          resolve(module);
        },
        (error) => {
          module.error = module.error || String(error);
          resolve(module);
        });
    });

    // TODO: Transform AST.
    // TODO: First instrument so that
    // *  Identify all prebakery declarations.
    // *  Transform import uses into callbacks to fetch and load the module
    //    and register imported symbols as prebake-relevant.
    // *  Wrap all side-effecting statements so that they only execute if they
    //    depend on a known prebaky symbol.
    // *  Similarly for require.
    // *  Adds call-site traps to potential calls to eval so we can substitute
    //    ASTs in-place.
    // *  Turn calls to Function into something that generates a function in the
    //    object pool.
    // *  All function calls go through a proxy that wraps potential object creators
    //    in a proxy that keeps a history so we can recreate it as part of the object
    //    pool.
    // *  Exports a function that we can call at the end to enumerate const variables.

    // See https://astexplorer.net/ using babel-eslint-7.2.3 as parser
    // TODO: Then run selected items.
  }
};