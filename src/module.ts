/**
 * @fileoverview
 * interface Module represents an ES262 or CJS module.
 * Exports include the Module type and subtypes for each processing stage.
 */

import {
  Node,
} from '@babel/core';

import { FetchContext } from './fetcher';
import { CanonModuleId, ModuleId, TentativeModuleId } from './module-id';
import { ModuleMetadata } from './module-metadata';
import { CassandraEvent } from './cassandra';

/**
 * The kind of module.
 * CJS modules are parsed as a FunctionBody and have `module` and `require`
 * in context.
 * ES262 use `import` and `export` declarations to connect to other modules.
 */
export type ModuleKind = 'cjs' | 'es262';

export const cjs: ModuleKind = 'cjs';
export const es262: ModuleKind = 'es262';

export type ModuleError = CassandraEvent;

export type ModuleSubtype<T extends Module> = new (...args: unknown[]) => T;

/**
 * Corresponds to an ES or CJS module.
 */
export interface Module {
  id: ModuleId;
  metadata: ModuleMetadata;
  source: string | null;
  originalAst: Node | null;
  rewrittenAst: Node | null;
  swissAst: Node | null;
  outputAst: Node | null;
  errors: ModuleError[] | null;

  constructor: new (...args: unknown[]) => this;
}

export interface CanonModule extends Module {
  id: CanonModuleId;
}

/**
 * A module that may turn out to be an alias of another module
 * once the id is canonicalized.
 */
export interface UnresolvedModule extends Module {
  id: TentativeModuleId;
  metadata: ModuleMetadata;
  /** Context about a fetch. */
  fetchContext: FetchContext;
  source: null;
  originalAst: null;
  rewrittenAst: null;
  swissAst: null;
  errors: null;
}
export class UnresolvedModule {
  source = null;
  originalAst = null;
  rewrittenAst = null;
  swissAst = null;
  errors = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(id: TentativeModuleId, fetchContext: FetchContext) {
    this.id = id;
    this.fetchContext = fetchContext;
    this.metadata = {
      base: fetchContext.moduleId,
      properties: {},
    };
  }
}

/**
 * A module with a resolve id that is not an alias of another non-tentative or error module.
 */
export interface ResolvedModule extends CanonModule {
  source: string;
  originalAst: null;
  rewrittenAst: null;
  swissAst: null;
  errors: null;
}
export class ResolvedModule {
  originalAst = null;
  rewrittenAst = null;
  swissAst = null;
  errors = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(id: CanonModuleId, source: string, metadata: ModuleMetadata) {
    this.id = id;
    this.source = source;
    this.metadata = metadata;
  }
}

/**
 * A module that is ready for early running.
 */
export interface RewrittenModule extends CanonModule {
  source: string;
  originalAst: Node;
  rewrittenAst: Node;
  swissAst: Node;
  errors: null;
}
export class RewrittenModule {
  errors = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(m: ResolvedModule, originalAst: Node, rewrittenAst: Node, swissAst: Node) {
    this.id = m.id;
    this.source = m.source;
    this.metadata = m.metadata;
    this.originalAst = originalAst;
    this.rewrittenAst = rewrittenAst;
    this.swissAst = swissAst;
  }
}

/**
 * A fully prebaked module.
 */
export interface OutputModule extends CanonModule {
  source: string;
  originalAst: Node;
  rewrittenAst: Node;
  swissAst: Node;
  outputAst: Node;
  errors: null;
}
export class OutputModule {
  errors = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(m: RewrittenModule, outputAst: Node) {
    this.id = m.id;
    this.source = m.source;
    this.metadata = m.metadata;
    this.originalAst = m.originalAst;
    this.rewrittenAst = m.rewrittenAst;
    this.swissAst = m.swissAst;
    this.outputAst = outputAst;
  }
}

/**
 * An error module that cannot be processed further.
 */
export interface ErrorModule extends Module {
  errors: ModuleError[];
}
export class ErrorModule {
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(m: Module, errors: ModuleError[]) {
    if (errors.length === 0) {  // Ironic?
      throw new Error();
    }
    this.id = m.id;
    this.source = m.source;
    this.metadata = m.metadata;
    this.originalAst = m.originalAst;
    this.rewrittenAst = m.rewrittenAst;
    this.swissAst = m.swissAst;
    this.outputAst = m.outputAst;

    this.errors = [...errors];
  }

  maybeMergeErrors(...modules: (Module | null)[]) {
    const merged = new Set();
    merged.add(this);
    for (const m of modules) {
      if (!m || merged.has(m)) {
        continue;
      }
      merged.add(m);
      if (m.errors) {
        this.errors.push(...m.errors);
      }
    }
  }
}

const stageOrder: Map<Function, number> = new Map([
  [ UnresolvedModule as Function, 0 ],
  [ ResolvedModule, 1 ],
  [ RewrittenModule, 2 ],
  [ OutputModule, 3 ],
  // Modules should never transition out of an error state so compare high.
  [ ErrorModule, 1000000000 ],
]);

/**
 * If a is later stage returns 1, -1 if earlier, 0 if same.
 * Assumes that a Module is an instance of one of the classes defined herein.
 */
export function compareModuleStage(
  a: Module | ModuleSubtype<Module>, b: Module | ModuleSubtype<Module>
): (-1 | 0 | 1) {
  let aCtor;
  if (typeof a === 'function') {
    aCtor = a;
  } else {
    aCtor = a.constructor;
  }

  let bCtor;
  if (typeof b === 'function') {
    bCtor = b;
  } else {
    bCtor = b.constructor;
  }

  const aNum = stageOrder.get(aCtor);
  if (typeof aNum !== 'number') {
    throw new Error(`Unrecognized module: ${ a }`);
  }
  const bNum = stageOrder.get(bCtor);
  if (typeof bNum !== 'number') {
    throw new Error(`Unrecognized module: ${ b }`);
  }
  // Type-safe since the difference cannot be NaN.
  return Math.sign(aNum - bNum) as (-1 | 0 | 1);
}
