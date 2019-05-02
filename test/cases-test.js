'use strict';

const fs = require('fs');
const path = require('path');
const { URL, pathToFileURL } = require('url');
const { expect } = require('chai');
const { describe, it } = require('mocha');

const { Prebakery } = require('../lib/prebake.js');
const { fileSystemFetcher } = require('../lib/src/fetcher.js');
const { CanonModuleId, TentativeModuleId } = require('../lib/src/module-id.js');

describe('cases', () => {
  const caseRoot = path.join(__dirname, 'cases');
  for (const subDir of fs.readdirSync(caseRoot)) {
    const caseDir = path.join(caseRoot, subDir);

    const inpJsPath = path.join(caseDir, 'inp.js');
    if (fs.existsSync(inpJsPath)) {
      it(subDir, (done) => {
        const prebakery = new Prebakery(
          fileSystemFetcher,
          new CanonModuleId(
            pathToFileURL(caseDir),
            pathToFileURL(fs.realpathSync.native(caseDir))));
        const parts = inpJsPath.split(path.sep).filter(Boolean);
        const inpUrl = new URL(`file:///${ parts.map(encodeURIComponent).join('/') }`);
        prebakery.prebake(new TentativeModuleId(inpUrl)).then(
          (moduleMap) => {
            for (const [key, value] of moduleMap.entries()) {
              console.log(`TEST GOT ${ require('util').inspect(key) }: ${ value.bakedSource || value.error }`);
            }
            done();
          },
          (error) => {
            done(error)
          });
      });
    }
  }
});
