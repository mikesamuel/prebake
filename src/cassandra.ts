import { CanonModuleId } from './module';

const { freeze } = Object;

export interface Cassandra {
  warn(moduleId: CanonModuleId, line: number, message: string): void;
  error(moduleId: CanonModuleId, line: number, message: string): void;
}

export function cassandraChain(...cassandras: Cassandra[]) {
  cassandras = [...cassandras];
  const n = cassandras.length;

  return freeze({
    warn(moduleId: CanonModuleId, line: number, message: string) {
      let exc = null;
      for (let i = 0; i < n; ++i) {
        try {
          cassandras[i].warn(moduleId, line, message);
        } catch (e) {
          exc = e;
        }
      }
      if (exc !== null) {
        throw exc;
      }
    },
    error(moduleId: CanonModuleId, line: number, message: string) {
      let exc = null;
      for (let i = 0; i < n; ++i) {
        try {
          cassandras[i].error(moduleId, line, message);
        } catch (e) {
          exc = e;
        }
      }
      if (exc !== null) {
        throw exc;
      }
    },
  });
}

export function cassandraToConsoleMaker(underlyingConsole: Console = global.console) {
  return freeze({
    warn(moduleId: CanonModuleId, line: number, message: string) {
      underlyingConsole.warn(`${ moduleId.abs.href }:${ line }: ${ message }`);
    },
    error(moduleId: CanonModuleId, line: number, message: string) {
      underlyingConsole.error(`${ moduleId.abs.href }:${ line }: ${ message }`);
    },
  });
}

export const cassandraToConsole = cassandraToConsoleMaker();
