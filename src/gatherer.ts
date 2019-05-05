import { Cassandra, CassandraEvent } from './cassandra';
import { ErrorModule, ResolvedModule, UnresolvedModule } from './module';
import { CanonModuleId } from './module-id';
import { ModuleSet } from './module-set';
import { FetchError, FetchResult, Fetcher, NotUnderstood, nullFetcher } from './fetcher';

/**
 * class Gatherer listens to a ModuleSet for new module ids, uses a Fetcher to replace
 * UnresolvedModules with ResolvedModules that have source code and metadata attached.
 */
export class Gatherer {
  private fetcher: Fetcher;
  private cassandra: Cassandra;
  private moduleSet: ModuleSet;
  /** Keep track of what we've fetched to avoid overlapping, redundant requests. */
  private previouslyFetched: Set<String> = new Set();

  constructor(fetcher: Fetcher, cassandra: Cassandra, moduleSet: ModuleSet) {
    this.fetcher = fetcher;
    this.cassandra = cassandra;
    this.moduleSet = moduleSet;

    // Listen for unresolved modules that this can resolve.
    this.moduleSet.onNewModule(
      async (m: UnresolvedModule) => {
        const base = m.fetchContext.moduleId;
        // Figure out the canonical ID.
        const canonResult: CanonModuleId | FetchError | NotUnderstood =
          await this.fetcher.canonicalize(m.id.abs, base, nullFetcher);

        // Deal with any canonicalization error.
        if (!(canonResult instanceof CanonModuleId)) {
          const error: CassandraEvent = {
            level: 'error',
            moduleId: base,
            line: m.fetchContext.line,
            message: `Failed to resolve import ${ m.id.abs }`,
          };
          if (canonResult instanceof NotUnderstood) {
            // Error message ok.
          } else if (canonResult instanceof FetchError) {
            error.message = canonResult.error;
          } else {
            error.message = `Canonicalize produced invalid result: ${ canonResult }`;
          }
          this.moduleSet.set(new ErrorModule(m, [error]));
          this.cassandra(error);
          return;
        }

        const canonId: CanonModuleId = canonResult;
        // Figure out whether we need to fetch the content.
        const previouslyFetchedKey = JSON.stringify({
          base: {
            abs: base.abs.href,
            canon: base.canon.href
          },
          target: {
            abs: canonId.abs.href,
            canon: canonId.canon.href
          },
        });
        if (this.previouslyFetched.has(previouslyFetchedKey)) {
          // No need to fetch source.  Fetch started via another ID.
          return;
        }
        this.previouslyFetched.add(previouslyFetchedKey);

        // Actually fetch the content.
        const fetchResult: FetchResult | FetchError | NotUnderstood =
          await this.fetcher.fetch(canonId, base, nullFetcher);
        // Deal with any error during fetching.
        if (!(fetchResult instanceof FetchResult)) {
          const error: CassandraEvent = {
            level: 'error',
            moduleId: base,
            line: m.fetchContext.line,
            message: `Failed to retrieve source text for ${ canonId.canon }`,
          };
          if (fetchResult instanceof NotUnderstood) {
            // Error message ok.
          } else if (fetchResult instanceof FetchError) {
            error.message = fetchResult.error;
          } else {
            error.message = `Fetch produced invalid result: ${ fetchResult }`;
          }
          this.moduleSet.set(new ErrorModule(m, [error]));
          this.cassandra(error);
          return;
        }

        // Create a resolved module.
        const { moduleSource, moduleMetadata } = fetchResult;
        const resolvedModule = new ResolvedModule(canonId, moduleSource, moduleMetadata);
        this.moduleSet.set(resolvedModule);
      });
  }
}

