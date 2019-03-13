'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { expect } = require('chai');
const { describe, it } = require('mocha');

const { Prebakery, fileSystemFetcher } = require('../lib/prebake.js');

describe('cases', () => {
  const caseRoot = path.join(__dirname, 'cases');
  for (const subDir of fs.readdirSync(caseRoot)) {
    const caseDir = path.join(caseRoot, subDir);

    const inpJsPath = path.join(caseDir, 'inp.js');
    if (fs.existsSync(inpJsPath)) {
      it(subDir, (done) => {
        const prebakery = new Prebakery(fileSystemFetcher(caseDir));
        const parts = inpJsPath.split(path.sep).filter(Boolean);
        const inpUrl = new URL(`file:///${ parts.map(encodeURIComponent).join('/') }`);
        prebakery.prebake(inpUrl).then(
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
