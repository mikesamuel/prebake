import { URL } from 'url';

const { defineProperty } = Object;

/** Identifies a module. */
export interface ModuleId {
  /** Absolute or non-hierarchical (like data:). */
  abs: URL;
  /** A URL whose string value can be used as a key for the module. */
  canon: URL | null;
}

// These interface sub-type the properties without requiring they
// be initialized.
// github.com/Microsoft/TypeScript/issues/14650#issuecomment-286512040
export interface CanonModuleId extends ModuleId {
  canon: URL;
}
export interface TentativeModuleId extends ModuleId {
  canon: null;
}

/** A module id that is guaranteed to have a canonical URL. */
export class CanonModuleId implements ModuleId {
  constructor(abs: URL, canon: URL) {
    defineProperty(
      this, 'abs',
      { value: Object.freeze(new URL(abs.href)), enumerable: true });
    defineProperty(
      this, 'canon',
      { value: Object.freeze(new URL(canon.href)), enumerable: true });
  }

  toString() {
    return this.abs.href;
  }
}

/** A module id whose canonical URL is not yet known. */
export class TentativeModuleId implements ModuleId {
  constructor(abs: URL) {
    defineProperty(
      this, 'abs',
      { value: Object.freeze(new URL(abs.href)), enumerable: true });
    defineProperty(
      this, 'canon',
      { value: null, enumerable: true });
  }

  toString() {
    return this.abs.href;
  }
}

/** Usable as a Map key and corresponds to a ModuleId. */
export type ModuleKey = string;
