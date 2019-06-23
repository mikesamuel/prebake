'use strict';

const fs = require('fs');
const path = require('path');
const { URL, pathToFileURL } = require('url');
const { promisify } = require('util');
const { expect } = require('chai');
const { describe, it } = require('mocha');

const { Prebakery } = require('../lib/prebake.js');
const { fileSystemFetcher } = require('../lib/src/fetcher.js');
const { RewrittenModule } = require('../lib/src/module.js');
const { CanonModuleId, TentativeModuleId } = require('../lib/src/module-id.js');

function undefIfEmpty(x) {
  if (x === null || x === undefined
      || ((typeof x === 'string' || Array.isArray(x)) && x.length === 0)) {
    return undefined;
  }
  return x;
}

describe('cases', () => {
  const caseRoot = path.join(__dirname, 'cases');
  for (const subDir of fs.readdirSync(caseRoot)) {
    const caseDir = path.join(caseRoot, subDir);

    const inpJsPath = path.join(caseDir, 'inp.js');
    const wantJsonPath = path.join(caseDir, 'want.json');

    const goldenSubs = {
      __proto__: null,
      $BASEDIR: caseDir,
      $BASEURL: pathToFileURL(caseDir),
    };
    function substituteIntoGoldens(_, x) {
      // JSON reviver that replaces $BASEDIR, etc. with relevant substring so
      // that test goldens are insensitive to location of path on file system.
      if (typeof x === 'string') {
        return x.replace(
          /(\\*)([$]\w+)/g,
          function (whole, slashes, key) {
            if ((slashes.length & 1) === 0 && key in goldenSubs) {
              return slashes + goldenSubs[key];
            }
            return whole;
          });
      } else if (x && typeof x === 'object' && !Array.isArray(x)) {
        const o = {};
        for (const [key, value] of Object.entries(x)) {
          o[substituteIntoGoldens(null, key)] = value;
        }
        return o;
      }
      return x;
    }

    if (fs.existsSync(inpJsPath)) {
      it(subDir, async () => {
        const logEntries = [];
        const cassandra = (event) => {
          logEntries.push(event);
        };
        let passed = false;
        try {
          const prebakery = new Prebakery(
            fileSystemFetcher,
            cassandra,
            new CanonModuleId(
              pathToFileURL(caseDir),
              pathToFileURL(fs.realpathSync.native(caseDir))));
          const parts = inpJsPath.split(path.sep).filter(Boolean);
          const inpModuleSpecifier = `/${ parts.map(encodeURIComponent).join('/') }`;
          const result = await prebakery.prebake(inpModuleSpecifier);
          const specifierToId = {};
          for (const [spec, id] of result.specifierToId) {
            specifierToId[spec] = id;
          }
          const finishPromises = [];
          for (const [key, module] of result.modules.entries()) {
            finishPromises.push(
              // TODO: glean target module stage from test config.
              result.moduleSet.onPromotionTo(module, RewrittenModule));
          }
          await Promise.all(finishPromises);

          const got = { specifierToId, logEntries, modules: {} };
          for (const finishedModule of result.moduleSet.modules()) {
            got.modules[finishedModule.id.key()] = {
              source: undefIfEmpty(finishedModule.source),
              errors: undefIfEmpty(finishedModule.errors),
              deps: undefIfEmpty(finishedModule.deps),
              rdeps: undefIfEmpty(finishedModule.rdeps),
            };
          }

          const want = JSON.parse(
            await promisify(fs.readFile)(wantJsonPath, { encoding: 'utf-8' }),
            substituteIntoGoldens);

          expect(JSON.stringify(got, null, 2))
            .to.equal(JSON.stringify(want, null, 2));
        } finally {
          if (!passed) {
            for (const { level, line, message, moduleId } of logEntries) {
              console.log(`${ moduleId }:${ line }:${ level }: ${ message }`);
            }
          }
        }
      });
    }
  }
});
