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

import { CassandraEvent, Cassandra } from '../cassandra';
import { FetchContext } from '../fetcher';
import { ErrorModule, Module, ResolvedModule, RewrittenModule } from '../module';
import { CanonModuleId } from '../module-id';
import { ModuleSet } from '../module-set';

import { findImportsExports } from './find-imports-exports';
import { parseOptions } from './parse-options';

import { Job } from './job';

import {
  BabelFileResult, Node, PluginObj, Visitor,
  parseAsync, transformFromAstAsync,
} from '@babel/core';
import { NodePath } from '@babel/traverse';

const pwd = cwd();

function keyOf(id: CanonModuleId): string {
  return id.canon.href;
}

export class Rewriter {
  private moduleSet: ModuleSet;
  private cassandra: Cassandra;
  /** Maps canon URL to module IO. */
  private jobs: Map<string, Job> = new Map();

  constructor(moduleSet: ModuleSet, cassandra: Cassandra) {
    this.moduleSet = moduleSet;
    this.moduleSet.onAnyPromotedTo(
      this.rewrite.bind(this),
      ResolvedModule.prototype.constructor);
    this.cassandra = cassandra;
  }

  private async rewrite(m: ResolvedModule): Promise<void> {
    const moduleKey = keyOf(m.id);
    const job = this.jobs.get(moduleKey) || new Job(m.id);
    this.jobs.set(moduleKey, job);
    if (job.state !== 'unstarted') {
      return;
    }
    job.state = 'started';

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
    job.originalAst = originalAst;

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
      this.abandon(job, errors);
      return;
    }

    const findings = await findImportsExports(originalAst);
    job.findings = findings;

    // Count number of module specifiers we need to resolve.
    for (const finding of findings) {
      const { moduleSpecifier } = finding;
      if (moduleSpecifier !== null) {
        job.unresolved.push(moduleSpecifier);
      }
    }

    // Start fetches for unresolved specifiers.
    for (const moduleSpecifier of job.unresolved) {
      const moduleIdStr = moduleSpecifier.value;
      const line = moduleSpecifier.loc ? moduleSpecifier.loc.start.line : -1;
      const context: FetchContext = {
        moduleId: m.id,
        level: 'info',
        line,
        message: 'import/export',
      };
      this.moduleSet.fetch(moduleIdStr, context).then(
        (dep: Module) => {
          job.unresolved.splice(job.unresolved.indexOf(moduleSpecifier), 1);

          const { errors, id: depId } = dep;
          if (!errors && depId instanceof CanonModuleId) {
            this.addDependency(job, depId);
          } else {
            if (!(errors && errors.length)) {
              this.cassandra({
                level: 'error',
                moduleId: m.id,
                line,
                message: `Import ${ JSON.stringify(moduleIdStr) } is missing a canonical URL`,
              });
            }
            const ce: CassandraEvent = {
              level: 'error',
              moduleId: m.id,
              line,
              message: `Import of ${ JSON.stringify(moduleIdStr) } failed`,
            };
            job.progressComments.push(ce);
            this.abandon(job, [ce]);
          }
        },
        (err: Error) => {
          const ce: CassandraEvent = {
            level: 'error',
            moduleId: m.id,
            line,
            message: `Import of ${ JSON.stringify(moduleIdStr) } failed: ${ err }`,
          };
          job.progressComments.push(ce);
          this.abandon(job, [ce]);
        });
    }

    this.checkSatisfied(job);

    return;
  }

  private abandon(job: Job, errors: CassandraEvent[]): void {
    if (job.state !== 'error') {
      job.state = 'error';
      const errModule = new ErrorModule(this.moduleSet.get(job.id) as Module, errors);
      this.moduleSet.set(errModule);
    }
  }

  private addDependency(src: Job, tgtId: CanonModuleId): void {
    const tgtKey = keyOf(tgtId);
    const tgt = this.jobs.get(tgtKey) || new Job(tgtId);
    this.jobs.set(tgtKey, tgt);
    tgt.rdeps.push(src);
    src.deps.push(tgt);
    this.checkSatisfied(src);
  }

  private checkSatisfied(job: Job) {
    if (job.state === 'started' && job.unresolved.length === 0) {
      job.state = 'satisfied';
    }
    if (job.state !== 'satisfied') {
      return;
    }
    const newlyCompleted: Job[] = [];
    // Check whether deps are transitively satisfied
    const toCheck = new Set([job]);
    do {
      const checking = [...toCheck];
      toCheck.clear();
      for (const jobToCheck of checking) {
        this.checkCompleted(jobToCheck, new Set([jobToCheck]), newlyCompleted);
        if (jobToCheck.state === 'complete') {
          // If we completed this one, check if things that depend on it are
          // completable.
          for (const rdep of jobToCheck.rdeps) {
            if (rdep.state === 'satisfied') {
              toCheck.add(rdep);
            }
          }
        }
      }
    } while (toCheck.size);

    for (const completed of newlyCompleted) {
      this.finish(completed);
    }
  }

  private checkCompleted(job: Job, checked: Set<Job>, newlyCompleted: Job[]) {
    if (job.state !== 'satisfied') {
      return;
    }
    let complete = true;  // Until proven otherwise
    for (const dep of job.deps) {
      if (checked.has(dep)) {
        if (!dep.recusrivelyDependsOnItself) {
          dep.recusrivelyDependsOnItself = true;
          dep.progressComments.push({
            level: 'info',
            moduleId: dep.id,
            line: 1,
            message:
              `Module ${ dep.id } recursively depends on itself via chain: ${ [...checked] }`,
          });
        }
        continue;
      }
      if (dep.state === 'satisfied') {
        checked.add(dep);
        this.checkCompleted(dep, checked, newlyCompleted);
        checked.delete(dep);
      }
      if (dep.state !== 'complete') {
        complete = false;
        break;
      }
    }
    if (complete && job.state === 'satisfied') {
      job.state = 'complete';
      newlyCompleted.push(job);
    }
  }

  private finish(job: Job) {
    const m = this.moduleSet.get(job.id);
    if (!(m instanceof ResolvedModule)) {
      throw new Error(
        `Rewriter expected ${ job.id } to correspond to a ResolvedModule, not ${
          m && m.constructor.name }`
      );
      return;
    }
    const { originalAst } = job;
    if (!originalAst) {
      throw new Error(`Cannot rewrite ${ job.id } due to missing AST`);
    }
//  const endLine = originalAst.loc ? originalAst.loc.end.line : 1;
    const visitor: Visitor<any> = {
      File(path: NodePath): void {
        for (const comment of job.progressComments) {
          // TODO use other fields
          path.addComment('LineComment', comment.message, true);
        }
      }
    };
    const plugin: PluginObj = { visitor };
    transformFromAstAsync(
      originalAst, m.source,
      {
        ast: true,
        code: false,
        plugins: [ plugin ],
      }
    ).then(
      (result: BabelFileResult | null) => {
        if (!result) {
          this.abandon(job, [{
            level: 'error',
            line: 0,
            moduleId: job.id,
            message: 'Failed to rewrite AST',
          }]);
          return;
        }
        const { ast: rewrittenAst } = result;
        if (!rewrittenAst) {
          throw new Error();
        }
        const swissAst = originalAst;  // TODO
        this.moduleSet.set(new RewrittenModule(m, originalAst, rewrittenAst, swissAst));
      },
      (err: Error) => {
        this.abandon(job, [{
          level: 'error',
          line: 0,
          moduleId: job.id,
          message: err.message,
        }]);
      });
  }
}
