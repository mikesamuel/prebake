/**
 * @fileoverview
 * class Rewriter listens for ResolvedModules and produces RewrittenModules.
 * Rewriter will find and fetch static dependencies, and delays rewriting until
 * static dependency content is available.
 *
 * This stage goes through 3 sub stages:
 * 1. Parse
 * 2. Compute static linkage info
 *    1. Parse content and extract static imports and exports
 *    2. Identify modules needed to compute which symbols are exported at which stages.
 *    3. Wait until those modules (export, stage) info is avilable.  This may involve
 *       identifying cyclically imported sets.
 *    4. Converge on a set of (export, stage) taking into account `export * from '...'` cycles.
 * 3. Generate instrumented and template ASTs.
 */

import { fileURLToPath } from 'url';
import { relative } from 'path';
import { cwd } from 'process';
import { ErrorModule, Module, ResolvedModule, /*RewrittenModule*/ } from '../module';
import { CanonModuleId } from '../module-id';
import { ModuleSet } from '../module-set';
import { CassandraEvent, Cassandra } from '../cassandra';
import { LinkType, Stage } from './io';
import { parseOptions } from './parse-options';
import {
  // @ts-ignore
  BabelFileResult,
  Node,
  // @ts-ignore
  ParseResult,
  parseAsync,
  // @ts-ignore
  transformFromAstSync,
  types,
} from '@babel/core';

const pwd = cwd();

interface ExportInfo {
  name: string;
  stage: Stage;
  node: types.Identifier | null;
  linkType: LinkType;
}

interface ImportInfo {
  name: string;
  stage: Stage;
  node: types.Identifier | null;
  linkType: LinkType;
  source: CanonModuleId;
}

class ModuleIO {
  exports: Map<string, ExportInfo> = new Map();
  imports: Map<string, ImportInfo> = new Map();
  starExports: Promise<CanonModuleId>[] = [];
}


export class Rewriter {
  private moduleSet: ModuleSet;
  private cassandra: Cassandra;
  /** Maps canon URL to module IO. */
  // @ts-ignore
  private moduleIos: Map<string, ModuleIO> = new Map();

  constructor(moduleSet: ModuleSet, cassandra: Cassandra) {
    this.moduleSet = moduleSet;
    this.moduleSet.onAnyPromotedTo(
      this.rewrite.bind(this),
      ResolvedModule.prototype.constructor);
    this.cassandra = cassandra;
  }

  private async rewrite(m: ResolvedModule): Promise<Module> {
    const filename: string =
      (m.id.canon.protocol === 'file:')
      ? relative(pwd, fileURLToPath(m.id.canon))
      : m.id.canon.href; // Dodgy but only for diagnostic purposes.

    const sourceCode: string = m.source;
    const errors: CassandraEvent[] = [];
    let originalAst: Node | null = null;
    try {
      originalAst = await parseAsync(
        sourceCode,
        {
          ...parseOptions,
          filename,
        });
    } catch (ex) {
      errors.push({
        level: 'error',
        moduleId: m.id,
        line: (ex.loc && typeof ex.loc === 'object' && +ex.loc.line) || 0,
        message: ex.message,
      });
    }
    for (const error of errors) {
      this.cassandra(error);
    }

    if (!originalAst || errors.length) {
      if (!errors.length) {
        const error: CassandraEvent = {
          level: 'error',
          moduleId: m.id,
          line: 0,
          message: 'Failed to parse',
        };
        this.cassandra(error);
        errors.push(error);
      }
      const em = new ErrorModule(m, errors);
      return this.moduleSet.set(em);
    }

    // TODO: identify non-transitive dependencies.

    // TODO: rewrite

    throw new Error('TODO');
  }
}
