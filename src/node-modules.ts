import { stat } from 'fs';
import { env, config } from 'process';
import { delimiter as pathDelimiter, dirname, join } from 'path';
import { fileURLToPath, pathToFileURL, URL } from 'url';
import { promisify } from 'util';

const { NODE_PATH, HOME } = env;
const { variables: { node_prefix } } = config;

declare const require: {
  resolve(moduleId: string, options?: { paths?: string[] }): string;
};

/** True if the given module specifier specifies a builtin module. */
export function isBuiltin(moduleSpecifier: string): boolean {
  // TODO: maybe just use https://www.npmjs.com/package/builtin-modules
  // Alternatively, could use require.resolve.paths since that does not throw.
  try {
    return !/^[./]|[\\:]/.test(moduleSpecifier)
        && moduleSpecifier === require.resolve(moduleSpecifier);
  } catch (e) {
    return false;
  }
}

/**
 * Mimics require.resolve but from a root that isn't related to the current module's dirname.
 * TODO: There has to be a builtin that does this.
 */
async function pathsRelativeTo(filePath: string): Promise<string[]> {
  const stats = await promisify(stat)(filePath);
  if (!stats.isDirectory()) {
    filePath = dirname(filePath);
  }
  const dirs = [];
  while (true) {
    dirs.push(join(filePath, 'node_modules'));
    const parent = dirname(filePath);
    if (parent === filePath) {
      break;
    }
    filePath = parent;
  }

  // https://nodejs.org/api/modules.html#modules_loading_from_the_global_folders
  if (NODE_PATH) {
    dirs.push(...NODE_PATH.split(new RegExp(pathDelimiter, 'g')));
  }
  if (HOME) {
    dirs.push(
      join(HOME, '.node_modules'),
      join(HOME, '.node_libraries'));
  }
  if (node_prefix) {
    dirs.push(join(node_prefix, 'lib', 'node'));
  }

  return dirs;
}

export async function resolve(moduleSpecifier: string, base: URL): Promise<URL | null> {
  if (isBuiltin(moduleSpecifier)) {
    return new URL(`builtin:${ moduleSpecifier }`);
  }
  if (base.protocol === 'file:'
      // Per CommonJS and ESM rules, specifiers that start with '/', './', or '../' resolve
      // relative to base, not via a node_modules lookup path.
      && !/^[.]{0,2}[/]/.test(moduleSpecifier)) {
    const paths: string[] = await pathsRelativeTo(fileURLToPath(base));
    try {
      return pathToFileURL(require.resolve(moduleSpecifier, { paths }));
    } catch (e) {
      return null;
    }
  }
  return new URL(moduleSpecifier, base);
}
