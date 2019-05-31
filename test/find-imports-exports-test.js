'use strict';

const { expect } = require('chai');
const { describe, xit, it, afterEach, beforeEach } = require('mocha');
const { parseOptions } = require('../lib/src/rewriter/parse-options');
const { findImportsExports } = require('../lib/src/rewriter/find-imports-exports');
const { parseSync } = require('@babel/core');

// A JSON converter that drops null properties.
function skipNull(k, v) {
  return '' + +k === k || v !== null ? v : undefined;
}

function norm(x) {
  return JSON.parse(JSON.stringify(x), skipNull);
}

async function runImpExpTest(source, want) {
  const ast = parseSync(source, parseOptions);
  const outputs = await findImportsExports(ast);
  expect(norm(want)).to.deep.equal(norm(outputs));
}

describe('rewriter/find-imports-exports', () => {
  it('empty', () => {
    return runImpExpTest('', []);
  });
  it('import one symbol', () => {
    return runImpExpTest(
      `import { x } from './foo';`,
      [
        {
          findingType: 'import',
          linkType: 'esm',
          moduleSpecifier: './foo',
          symbols: [
            {
              line: 1,
              local: 'x',
              remote: 'x',
            },
          ]
        }
      ]);
  });
  it('more import', () => {
    return runImpExpTest(
      `// Comment
      import /* @prebake.runtime */ bar,
             { x as y, y as /* */ /* @prebake.moot */ x, /* @prebake.eager */ z }
      from './b\\x61r';
      `,
      [
        {
          findingType: 'import',
          linkType: 'esm',
          moduleSpecifier: './bar',
          symbols: [
            {
              line: 2,
              local: 'bar',
              remote: 'default',
              stage: 'runtime',
            },
            {
              line: 3,
              local: 'y',
              remote: 'x',
            },
            {
              line: 3,
              local: 'x',
              remote: 'y',
              stage: 'moot',
            },
            {
              line: 3,
              local: 'z',
              remote: 'z',
              stage: 'eager',
            },
          ]
        }
      ]);
  });
  it('dynamic import ignored', () => {
    return runImpExpTest(
      'const name = import("staticString");',
      []);
  });
  it('import *', () => {
    return runImpExpTest(
      `import * as /*@prebake.runtime*/ namespace from './wildcard';`,
      [
        {
          findingType: 'import',
          linkType: 'esm',
          moduleSpecifier: './wildcard',
          symbols: [
            {
              line: 1,
              local: 'namespace',
              remote: '*',
              stage: 'runtime',
            },
          ],
        },
      ]);
  });
  it('export names', () => {
    return runImpExpTest(
      `export { a as b, /* @prebake.moot */ c };`,
      [
        {
          findingType: 'export',
          linkType: 'esm',
          symbols: [
            {
              line: 1,
              local: 'a',
              remote: 'b',
            },
            {
              line: 1,
              local: 'c',
              remote: 'c',
              stage: 'moot',
            },
          ],
        },
      ]);
  });
  it('export name from', () => {
    return runImpExpTest(
      `export { a } from './a';`,
      [
        {
          findingType: 'export',
          linkType: 'esm',
          moduleSpecifier: './a',
          symbols: [
            {
              line: 1,
              local: 'a',
              remote: 'a',
            },
          ],
        },
      ]);
  });
  it('export let destructuring', () => {
    return runImpExpTest(
      `
      export let {
        /* @prebake.eager */ a = x,
        b: /* @prebake.moot */ c,
        d: [ e, , /* @prebake.runtime */ f, ...g ],
        ['h']: i,
      } = o;
      `,
      [
        {
          findingType: 'export',
          linkType: 'esm',
          symbols: [
            {
              line: 3,
              remote: 'a',
              stage: 'eager',
            },
            {
              line: 4,
              remote: 'c',
              stage: 'moot',
            },
            {
              line: 5,
              remote: 'e',
            },
            {
              line: 5,
              remote: 'f',
              stage: 'runtime',
            },
            {
              line: 5,
              remote: 'g',
            },
            {
              line: 6,
              remote: 'i',
            },
          ],
        },
      ]);
  });
  it('export const', () => {
    return runImpExpTest(
      `export const a = b, /** @prebake.runtime */ c = 123;`,
      [
        {
          findingType: 'export',
          linkType: 'esm',
          symbols: [
            {
              line: 1,
              local: 'a',
              remote: 'a',
            },
            {
              line: 1,
              local: 'c',
              remote: 'c',
              stage: 'runtime',
            },
          ],
        },
      ]);
  });
  it('export namespace from', () => {
    return runImpExpTest(
      `export * as foo from './foo';`,
      [
        {
          findingType: 'export',
          linkType: 'esm',
          moduleSpecifier: './foo',
          symbols: [
            {
              line: 1,
              local: '*',
              remote: 'foo',
            },
          ],
        },
      ]);
  });
  it('export namespace from', () => {
    return runImpExpTest(
      `export * as foo from './foo';`,
      [
        {
          findingType: 'export',
          linkType: 'esm',
          moduleSpecifier: './foo',
          symbols: [
            {
              line: 1,
              local: '*',
              remote: 'foo',
            },
          ],
        },
      ]);
  });
  it('export default', () => {
    return runImpExpTest(
      `
      const x = 1;
      export /* @prebake.runtime */ default x;`,
      [
        {
          findingType: 'export',
          linkType: 'esm',
          symbols: [
            {
              remote: 'default',
              stage: 'runtime',
            },
          ],
        },
      ]);
  });
  it('export function', () => {
    return runImpExpTest(
      `
      export /** @prebake.runtime */ function f() {}
      export /** @prebake.moot */ async function* g() {}
      export function* /** @prebake.eager */ h() {}
      `,
      [
        {
          findingType: 'export',
          linkType: 'esm',
          symbols: [
            {
              line: 2,
              local: 'f',
              remote: 'f',
              stage: 'runtime',
            },
          ],
        },
        {
          findingType: 'export',
          linkType: 'esm',
          symbols: [
            {
              line: 3,
              local: 'g',
              remote: 'g',
              stage: 'moot',
            },
          ],
        },
        {
          findingType: 'export',
          linkType: 'esm',
          symbols: [
            {
              line: 4,
              local: 'h',
              remote: 'h',
              stage: 'eager',
            },
          ],
        },
      ]);
  });
  it('bare require', () => {
    return runImpExpTest(
      `require('./foo')`,
      [
        {
          findingType: 'import',
          linkType: 'cjs',
          moduleSpecifier: './foo',
          symbols: [],
        },
      ]);
  });
  it('dynamic require', () => {
    return runImpExpTest(
      `require(x)`,
      []);
  });
  it('require in initializer', () => {
    return runImpExpTest(
      `const namespace = require('./foo');`,
      [
        {
          findingType: 'import',
          linkType: 'cjs',
          moduleSpecifier: './foo',
          symbols: [
            {
              line: 1,
              local: 'namespace',
              remote: '*',
            },
          ],
        },
      ]);
  });
  it('require in destructured initializer', () => {
    // TODO: try without const
    return runImpExpTest(
      `const { a, /* @prebake.moot */ b, c: d, ...rest } = require('foo');`,
      [
        {
          findingType: 'import',
          linkType: 'cjs',
          moduleSpecifier: 'foo',
          symbols: [
            {
              line: 1,
              local: 'a',
              remote: 'a',
            },
            {
              line: 1,
              local: 'b',
              remote: 'b',
              stage: 'moot',
            },
            {
              line: 1,
              local: 'd',
              remote: 'c',
            },
            {
              line: 1,
              local: 'rest',
              remote: '*',
            },
          ],
        },
      ]);
  });
  it('require masked', () => {
    return runImpExpTest(
      `
      const x = require('./x');
      function require(x) { console.log(x); }
      `,
      []);
  });
  it('module.exports.x = ', () => {
    return runImpExpTest(
      `module.exports.x = 123;`,
      [
        {
          findingType: 'export',
          linkType: 'cjs',
          symbols: [
            {
              local: null,
              remote: 'x',
              line: 1,
            },
          ],
        },
      ]);
  });
  it('module.exports = {}', () => {
    return runImpExpTest(
      `
      module.exports = {
        a,
        /* @prebake.eager */ b: c,
        d() {},
        [e]: f,
        // Namespace export
        g: require('foo'),
        // Fold another module's exports into this module's.
        ...require('bar'),
      };`,
      [
        {
          findingType: 'export',
          linkType: 'cjs',
          moduleSpecifier: 'foo',
          symbols: [
            {
              remote: 'g',
              local: '*',
              line: 8,
            },
          ],
        },
        {
          findingType: 'export',
          linkType: 'cjs',
          moduleSpecifier: 'bar',
          symbols: [
            {
              local: '*',
              remote: '*',
            },
          ],
        },
        {
          findingType: 'export',
          linkType: 'cjs',
          symbols: [
            {
              remote: 'a',
              line: 3,
            },
            {
              remote: 'b',
              stage: 'eager',
              line: 4,
            },
            {
              remote: 'd',
              line: 5,
            },
          ],
        },
      ]);
  });
  xit('module.exports = require(...)', () => {
    // Is this actually used as an idiom for re-exporting another module's content as one's own?
  });
  xit('module.exports masked', () => {
    return runImpExpTest(
      `function f(module) { module.exports = { a: 1 }; }`,
      []);
  });
  xit('local = require(...).remote', () => {
    // Cherrypick import
  });
});
