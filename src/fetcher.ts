import { readFile, realpath } from 'fs';
import { URL, fileURLToPath, pathToFileURL } from 'url';
import { CanonModuleId, ModuleMetadata } from './module';
import { Glob } from 'glob';

const { freeze } = Object;

let oneCreated: boolean = false;

export class NotUnderstood {
  // @ts-ignore never used
  private notStructural: null = null;

  constructor() {
    if (oneCreated) {
      throw new TypeError('NOT_UNDERSTOOD is singleton');
    }
    oneCreated = true;
  }

  toString() {
    return '#NOT_UNDERSTOOD#';
  }
}

export const NOT_UNDERSTOOD : NotUnderstood = new NotUnderstood();
freeze(NOT_UNDERSTOOD);


export class FetchResult {
  moduleId: CanonModuleId;
  moduleSource: string;
  moduleMetadata: ModuleMetadata;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(
    moduleId: CanonModuleId,
    moduleSource: string,
    moduleMetadata: ModuleMetadata) {
    this.moduleId = moduleId;
    this.moduleSource = moduleSource;
    this.moduleMetadata = moduleMetadata;
  }
}

export class FetchError {
  error: string;
  // @ts-ignore never used
  private notStructural: null = null;

  constructor(error: string) {
    this.error = error;
  }

  toString(): string {
    return this.error;
  }
}

export interface Fetcher {
  canonicalize(moduleUrl: URL, base: CanonModuleId, next: Fetcher)
      : Promise<CanonModuleId | FetchError | NotUnderstood>;
  list(moduleGlob: string, base: CanonModuleId, next: Fetcher)
      : Promise<Iterator<CanonModuleId> | FetchError | NotUnderstood>;
  fetch(moduleId: CanonModuleId, base: CanonModuleId, next: Fetcher)
      : Promise<FetchResult | FetchError | NotUnderstood>;
}

export const nullFetcher = freeze({
  canonicalize() : Promise<NotUnderstood> {
    return Promise.resolve(NOT_UNDERSTOOD);
  },
  list() : Promise<NotUnderstood> {
    return Promise.resolve(NOT_UNDERSTOOD);
  },
  fetch() : Promise<NotUnderstood> {
    return Promise.resolve(NOT_UNDERSTOOD);
  },
});

export function fetcherChain(...fetchers: Fetcher[]) {
  fetchers = [...fetchers];
  const n = fetchers.length;

  function chain(left : number, afterChain: Fetcher) {
    if (left === n) {
      return afterChain;
    }
    return freeze({
      async canonicalize(moduleUrl: URL, base: CanonModuleId, next: Fetcher)
          : Promise<CanonModuleId | FetchError | NotUnderstood> {
        for (let i = left; i < n; ++i) {
          let result = await (fetchers[i].canonicalize(moduleUrl, base, chain(left + 1, next)));
          if (result instanceof NotUnderstood) {
            continue;
          }
          return result;
        }
        return NOT_UNDERSTOOD;
      },
      async list(moduleGlob: string, base: CanonModuleId, next: Fetcher)
          : Promise<Iterator<CanonModuleId> | FetchError | NotUnderstood> {
        for (let i = left; i < n; ++i) {
          let result = await (fetchers[i].list(moduleGlob, base, chain(left + 1, next)));
          if (result instanceof NotUnderstood) {
            continue;
          }
          return result;
        }
        return NOT_UNDERSTOOD;
      },
      async fetch(moduleId: CanonModuleId, base: CanonModuleId, next: Fetcher)
          : Promise<FetchResult | FetchError | NotUnderstood> {
        for (let i = left; i < n; ++i) {
          let result = await (fetchers[i].fetch(moduleId, base, chain(left + 1, next)));
          if (result instanceof NotUnderstood) {
            continue;
          }
          return result;
        }
        return NOT_UNDERSTOOD;
      },
    });
  }
  return chain(0, nullFetcher);
}

/** Given a root directory, returns a fetcher. */
export const fileSystemFetcher : Fetcher = freeze({
  canonicalize(moduleUrl: URL)
      : Promise<CanonModuleId | FetchError | NotUnderstood> {
    if (moduleUrl.protocol !== 'file:') {
      return Promise.resolve(NOT_UNDERSTOOD);
    }
    return new Promise((resolve) => {
      realpath.native(moduleUrl.pathname, (err, resolvedPath) => {
        if (err != null) {
          resolve(new FetchError(String(err)));
        } else {
          resolve(new CanonModuleId(moduleUrl, pathToFileURL(resolvedPath)));
        }
      });
    });
  },

  list(moduleGlob: string, base: CanonModuleId)
      : Promise<Iterator<CanonModuleId> | FetchError | NotUnderstood> {
    if (base.abs.protocol !== 'file:') {
      return Promise.resolve(NOT_UNDERSTOOD);
    }
    const thisFetcher = this;
    return new Promise((resolve) => {
      new Glob(
        moduleGlob,
        {
          root: fileURLToPath(base.abs.pathname),
          strict: true,
          nonull: false,
        },
        (err: Error | null, files: string[]) => {
          if (err) {
            resolve(new FetchError(String(err)));
          } else {
            const promises = files.map(
              (file) => thisFetcher.canonicalize(pathToFileURL(file)));
            Promise.all(promises).then(
              (results : Array<CanonModuleId | FetchError | NotUnderstood>) => {
                const moduleIds = [];
                for (let i = 0, n = results.length; i < n; ++i) {
                  const result = results[i];
                  if (result instanceof CanonModuleId) {
                    moduleIds[i] = result;
                  } else {
                    resolve(
                      (result && typeof (result as any).error === 'string')
                      ? result as FetchError
                      : new FetchError(`${ files[i] } not canonicalized by fs fetcher`));
                    return;
                  }
                }
                resolve(moduleIds[Symbol.iterator]());
              });
          }
        });
    });
  },

  fetch(moduleId: CanonModuleId, base: CanonModuleId)
      : Promise<FetchResult | FetchError | NotUnderstood> {
    if (moduleId.canon.protocol !== 'file:') {
      return Promise.resolve(NOT_UNDERSTOOD);
    }
    let path = fileURLToPath(moduleId.canon);

    return new Promise((resolve) => {
      readFile(path, { encoding: 'UTF-8' }, (error, data) => {
        if (error) {
          resolve(new FetchError(String(error)));
        } else {
          const moduleMetadata = {
            base,
            properties: {},
          };

          resolve(new FetchResult(moduleId, data, moduleMetadata));
        }
      });
    });
  },
});
