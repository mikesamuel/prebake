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
  kind: ModuleKind;
  source: string | null;
  originalAst: Node | null;
  rewrittenAst: Node | null;
  swissAst: Node | null;
  outputAst: Node | null;
  error: ModuleError | null;
}

/**
 * A module that may turn out to be an alias of another module
 * once the id is canonicalized.
 */
export interface UnfetchedModule extends Module {
  id: TentativeModuleId;
  kind: ModuleKind;
  source: null;
  originalAst: null;
  rewrittenAst: null;
  swissAst: null;
  error: null;
}
export class UnfetchedModule {
  id: TentativeModuleId;
  kind: ModuleKind;
  source = null;
  originalAst = null;
  rewrittenAst = null;
  swissAst = null;
  error = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(id: TentativeModuleId, kind: ModuleKind) {
    this.id = id;
    this.kind = kind;
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
  error: null;
}
export class ResolvedModule {
  id: CanonModuleId;
  kind: ModuleKind;
  source: string;
  originalAst = null;
  rewrittenAst = null;
  swissAst = null;
  error = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(id: CanonModuleId, kind: ModuleKind, source: string) {
    this.id = id;
    this.kind = kind;
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
  error: null;
}
export class RewrittenModule {
  id: CanonModuleId;
  kind: ModuleKind;
  source: string;
  originalAst: Node;
  rewrittenAst: Node;
  swissAst: Node;
  error = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(m: ResolvedModule, originalAst: Node, rewrittenAst: Node, swissAst: Node) {
    this.id = m.id;
    this.kind = m.kind;
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
  error: null;
}
export class OutputModule {
  id: CanonModuleId;
  kind: ModuleKind;
  source: string;
  originalAst: Node;
  rewrittenAst: Node;
  swissAst: Node;
  error = null;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(m: RewrittenModule, outputAst: Node) {
    this.id = m.id;
    this.kind = m.kind;
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
  error: ModuleError;
}
export class ErrorModule {
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(m: Module, error: ModuleError) {
    this.id = m.id;
    this.kind = m.kind;
    this.source = m.source;
    this.originalAst = m.originalAst;
    this.rewrittenAst = m.rewrittenAst;
    this.swissAst = m.swissAst;
    this.outputAst = m.outputAst;

    this.error = error;
  }
}
