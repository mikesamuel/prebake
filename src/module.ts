/**
 * @fileoverview
 * class Module represents an ES262 or CJS module.
 * Exports include the Module type and subtypes for each processing stage.
 */

import {
  Node,
} from '@babel/core';

import { CanonModuleId, ModuleId, TentativeModuleId } from './module-id';
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

/**
 * Corresponds to an ES or CJS module.
 */
export interface Module {
  id: ModuleId;
  source: string | null;
  originalAst: Node | null;
  rewrittenAst: Node | null;
  swissAst: Node | null;
  outputAst: Node | null;
  errors: ModuleError[] | null;
}

/**
 * A module that may turn out to be an alias of another module
 * once the id is canonicalized.
 */
export interface UnresolvedModule extends Module {
  id: TentativeModuleId;
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
  error = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(id: TentativeModuleId) {
    this.id = id;
  }
}

/**
 * A module with a resolve id that is not an alias of another non-tentative or error module.
 */
export interface ResolvedModule extends Module {
  id: CanonModuleId;
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
  error = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(id: CanonModuleId, source: string) {
    this.id = id;
    this.source = source;
  }
}

/**
 * A module that is ready for early running.
 */
export interface RewrittenModule extends Module {
  id: CanonModuleId;
  source: string;
  originalAst: Node;
  rewrittenAst: Node;
  swissAst: Node;
  errors: null;
}
export class RewrittenModule {
  error = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(m: ResolvedModule, originalAst: Node, rewrittenAst: Node, swissAst: Node) {
    this.id = m.id;
    this.source = m.source;
    this.originalAst = originalAst;
    this.rewrittenAst = rewrittenAst;
    this.swissAst = swissAst;
  }
}

/**
 * A fully prebaked module.
 */
export interface OutputModule extends Module {
  id: CanonModuleId;
  source: string;
  originalAst: Node;
  rewrittenAst: Node;
  swissAst: Node;
  outputAst: Node;
  errors: null;
}
export class OutputModule {
  error = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(m: RewrittenModule, outputAst: Node) {
    this.id = m.id;
    this.source = m.source;
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

export interface CanonModule extends Module {
  id: CanonModuleId;
}
