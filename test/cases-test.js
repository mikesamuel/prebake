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
        const logEntries = [];
        const cassandra = (event) => {
          logEntries.push(event);
        };
        const prebakery = new Prebakery(
          fileSystemFetcher,
          cassandra,
          new CanonModuleId(
            pathToFileURL(caseDir),
            pathToFileURL(fs.realpathSync.native(caseDir))));
        const parts = inpJsPath.split(path.sep).filter(Boolean);
        const inpModuleSpecifier = `/${ parts.map(encodeURIComponent).join('/') }`;
        prebakery.prebake(inpModuleSpecifier).then(
          ({ modules, specifierToId }) => {
            const got = { specifierToId, logEntries, modules: {} };
            for (const [key, value] of modules.entries()) {
              got.modules[key] = value.source || value.errors;
            }
            // TODO: compare got to golden
            done();
          },
          (error) => {
            for (const { level, line, message, moduleId } of logEntries) {
              console.log(`${ moduleId }:${ line }:${ level }: ${ message }`);
            }
            done(error);
          });
      });
    }
  }
});
