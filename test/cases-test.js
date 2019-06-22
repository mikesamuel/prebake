'use strict';

const fs = require('fs');
const path = require('path');
const { URL, pathToFileURL } = require('url');
const { promisify } = require('util');
const { expect } = require('chai');
const { describe, it, xit } = require('mocha');

const { Prebakery } = require('../lib/prebake.js');
const { fileSystemFetcher } = require('../lib/src/fetcher.js');
const { RewrittenModule } = require('../lib/src/module.js');
const { CanonModuleId, TentativeModuleId } = require('../lib/src/module-id.js');

describe('cases', () => {
  const caseRoot = path.join(__dirname, 'cases');
  for (const subDir of fs.readdirSync(caseRoot)) {
    const caseDir = path.join(caseRoot, subDir);

    const inpJsPath = path.join(caseDir, 'inp.js');
    const wantJsonPath = path.join(caseDir, 'want.json');

    if (fs.existsSync(inpJsPath)) {
      xit(subDir, async () => {
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
          const got = { specifierToId, logEntries, modules: {} };
          const finishPromises = [];
          for (const [key, module] of result.modules.entries()) {
            const moduleData = {
              source: module.source || undefined,
              errors: module.errors || undefined,
            };
            got.modules[key] = moduleData;
            finishPromises.push(
              // TODO: glean target module stage from test config.
              result.moduleSet.onPromotionTo(module, RewrittenModule).then(
                async (finishedModule) => {
                  if (finishedModule.errors) {
                    moduleData.errors = finishedModule.errors;
                  } else {
                    moduleData.deps = finishedModule.deps || [];
                    moduleData.rdeps = finishedModule.rdeps || [];
                  }
                  return finishedModule;
                }));
          }
          await Promise.all(finishPromises);

          const expected = await promisify(fs.readFile)(wantJsonPath, { encoding: 'utf-8' });
          expect(JSON.stringify(got, null, 2))
            .to.equal(JSON.stringify(JSON.parse(expected), null, 2));
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
