/**
 * @fileoverview
 * class job collects information needed to rewrite a module as it and its
 * dependencies are processed.
 */

import { CanonModuleId } from '../module-id';
import { Node, types } from '@babel/core';
import { CassandraEvent } from '../cassandra';
import { ImportExportFinding } from './find-imports-exports';

export type JobState =
  'unstarted' // Has not found imports and exports
  | 'started' // Has content but dependencies may be being fetched.
  | 'satisfied' // All static dependencies started; unresolved is empty.
  | 'complete' // Dependencies are transitively satisfied.
  | 'error'; // Not completable.

export class Job {
  /** The id of the module being processed. */
  id: CanonModuleId;
  /** Any jobs that this imports from. */
  deps: Job[] = [];
  /** Reverse of deps: jobs who have this job on their deps list. */
  rdeps: Job[] = [];
  /** Anything that will be on deps once the module specifier has been resolved. */
  unresolved: types.StringLiteral[] = [];

  /** The AST parsed from the source text of the module identified by this.id. */
  originalAst: Node | null = null;
  /** Findings about static imports and exports including the CJS equivalents. */
  findings: ImportExportFinding[] = [];
  /**
   * Comments that could be added to the rewritten AST to aid in debugging the prebakery.
   */
  progressComments: CassandraEvent[] = [];
  state: JobState = 'unstarted';

  /**
   * True iff a module recursively depends on itself, for example, by exporting * from
   * something that also exports * from it.
   */
  recusrivelyDependsOnItself = false;

  constructor(id: CanonModuleId) {
    this.id = id;
  }
}
