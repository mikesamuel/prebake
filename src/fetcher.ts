import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { ModuleId } from './module-types';

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
