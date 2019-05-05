'use strict';

const { URL } = require('url');
const { expect } = require('chai');
const { describe, it, after, before } = require('mocha');
const { FetchError, FetchResult, NOT_UNDERSTOOD } = require('../lib/src/fetcher.js');
const { UnresolvedModule, ResolvedModule } = require('../lib/src/module.js');
const { CanonModuleId } = require('../lib/src/module-id.js');
const { ModuleSet } = require('../lib/src/module-set.js');
const { Gatherer } = require('../lib/src/gatherer.js');

const javascriptFetcher = {
  canonicalize(url, base) {
    const { protocol, pathname } = url;
    if ('javascript:' !== protocol) {
      return Promise.resolve(NOT_UNDERSTOOD);
    }
    return new Promise((resolve) => {
      setTimeout(
        () => {
          let canonJs;
          try {
            canonJs = encodeURIComponent(decodeURIComponent(pathname));
          } catch (e) {
            resolve(new FetchError(e.message));
            return;
          }
          resolve(new CanonModuleId(url, new URL(`javascript:${ canonJs }`)));
        },
        0);
    });
  },
  list() {
    return Promise.resolve(NOT_UNDERSTOOD);
  },
  fetch(id, base) {
    const { canon: { protocol, pathname } } = id;
    if ('javascript:' !== protocol) {
      return Promise.resolve(NOT_UNDERSTOOD);
    }
    return new Promise((resolve) => {
      setTimeout(
        () => {
          resolve(new FetchResult(
            id,
            decodeURIComponent(pathname),
            {
              base,
              properties: {}
            }
          ));
        },
        0);
    });
  },
};

describe('gatherer', () => {
  let moduleSet;
  let messages = [];
  let cassandra = (e) => { messages.push(e); };

  before(() => {
    messages.length = 0;
    moduleSet = new ModuleSet();
  });

  after(() => {
    // Tests should consume error messages.
    expect(messages).to.deep.equal([]);
  });

  it('simple javascript', (done) => {
    const baseUrl = new URL('about:allyourbase');
    const base = new CanonModuleId(baseUrl, baseUrl);
    const gatherer = new Gatherer(javascriptFetcher, cassandra, moduleSet);

    function fail(err) {
      done(err);
    }

    moduleSet.fetch(
      'javascript:alert( 1 )',
      {
        moduleId: base,
        line: 123,
        level: 'info',
        message: 'Have a nice day!'
      }).then(wantUnresolved, fail);

    function wantUnresolved(m) {
      if (m instanceof UnresolvedModule) {
        if (m.id.abs.href !== 'javascript:alert( 1 )') {
          done(new Error(`Wrong id in ${ JSON.stringify(m) }`));
        } else {
          moduleSet.onResolution(m).then(wantResolved, fail);
        }
      } else {
        done(new Error(`Got ${ m.constructor.name } not UnresolvedModule`));
      }
    }

    function wantResolved(m) {
      const mObj = {...m};
      for (const key of Object.keys(mObj)) {
        if (mObj[key] === null) {
          delete mObj[key];
        }
      }
      const got = JSON.stringify(mObj);
      const want = JSON.stringify({
        id: {
          abs: 'javascript:alert( 1 )',
          canon: 'javascript:alert(%201%20)',
        },
        source: 'alert( 1 )',
        metadata: {
          base: {
            abs: 'about:allyourbase',
            canon: 'about:allyourbase',
          },
          properties: {},
        },
      });
      if (want !== got) {
        done(new Error(`Got ${ want } but wanted ResolvedModule ${ got }`));
      } else {
        done();
      }
    }
  });
});
