import { CanonModuleId } from './module-id';

export interface ModuleMetadata {
  base: CanonModuleId;
  // TODO  contentType
  // TODO  sourceMap
  // TODO  importMap
  properties: { [key: string]: any };
}
