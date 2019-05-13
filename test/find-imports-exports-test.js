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
  const outputs = [];
  const ast = parseSync(source, parseOptions);
  await findImportsExports(ast, outputs);
  if (!outputs.length && want.length) {  // DO NOT COMMIT
    console.log(JSON.stringify(ast, null, 2));
  }
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
  xit('require', () => {
    // TODO
  });
  xit('module.exports.x = ', () => {
    // TODO
  });
  xit('module.exports = {}', () => {
    // TODO
  });
  xit('module.exports = y', () => {
    // TODO
  });
});
