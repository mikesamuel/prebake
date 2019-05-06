import { ModuleId } from './module-id';

export type logLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CassandraEvent {
  level: logLevel;
  moduleId: ModuleId;
  /** In the identified module. */
  line: number | null;
  /** Human readable text. */
  message: string;
}

export type Cassandra = (e: CassandraEvent) => void;

export function nullCassandra(_: CassandraEvent): void {
  // This FunctionBody left intentionally blank.
}

export function cassandraChain(...cassandras: Cassandra[]) {
  cassandras = [...cassandras];
  const n = cassandras.length;

  return (e: CassandraEvent) => {
    let exc = null;
    for (let i = 0; i < n; ++i) {
      try {
        cassandras[i]({...e});
      } catch (e) {
        exc = e;
      }
    }
    if (exc !== null) {
      throw exc;
    }
  };
}

export function cassandraToConsoleMaker(underlyingConsole: Console = global.console) {
  return ({ level, line, message, moduleId }: CassandraEvent) => {
    underlyingConsole[level](`${ moduleId.abs.href }:${ line }: ${ message }`);
  };
}

export const cassandraToConsole = cassandraToConsoleMaker();
