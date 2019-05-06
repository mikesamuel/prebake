'use strict';

const { URL } = require('url');
const { expect } = require('chai');
const { describe, xit, it, afterEach, beforeEach } = require('mocha');
const { FetchError, FetchResult, NOT_UNDERSTOOD } = require('../lib/src/fetcher.js');
const { UnresolvedModule, ResolvedModule } = require('../lib/src/module.js');
const { CanonModuleId } = require('../lib/src/module-id.js');
const { ModuleSet } = require('../lib/src/module-set.js');
const { Gatherer } = require('../lib/src/gatherer.js');

function skipNull(k, x) {  // Suitable as a JSON replacer
  if (x === null && +k !== +k) {
    return void 0;
  }
  return x;
}

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

  beforeEach(() => {
    messages.length = 0;
    moduleSet = new ModuleSet();
  });

  afterEach(() => {
    // Tests should consume messages.
    expect(messages).to.deep.equal([]);
  });

  it('one javascript:', (done) => {
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
      const got = JSON.stringify(m, skipNull);
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

  it('overlapping javascript:', (done) => {
    const fooUrl = new URL('id:foo');
    const fooId = new CanonModuleId(fooUrl, fooUrl);
    const barUrl = new URL('id:bar');
    const barId = new CanonModuleId(barUrl, barUrl);
    const gatherer = new Gatherer(javascriptFetcher, cassandra, moduleSet);

    function fail(err) {
      done(err);
    }

    // Two uncanonical but via different bases, one canon, one duplcate.
    const requestCount = 4;

    moduleSet.fetch(
      'javascript:alert( 1 )',
      {
        moduleId: fooId,
        line: 1,
        level: 'info',
        message: 'Have a nice day!'
      }).then(wantUnresolved, fail);

    moduleSet.fetch(
      'javascript:alert( 1%20)',  // Canonicalizes to same as p0
      {
        moduleId: fooId,
        line: 2,
        level: 'info',
        message: 'Have a nice day!'
      }).then(wantUnresolved, fail);

    moduleSet.fetch(  // Different requestor
      'javascript:alert( 1 )',
      {
        moduleId: barId,
        line: 1,
        level: 'info',
        message: 'Have a nice day!'
      }).then(wantUnresolved, fail);

    moduleSet.fetch(  // Exact duplicate
      'javascript:alert( 1 )',
      {
        moduleId: barId,
        line: 1,
        level: 'info',
        message: 'Have a nice day!'
      }).then(wantUnresolved, fail);

    const resolutionPromises = [];

    function wantUnresolved(m) {
      messages.push(`${ m.constructor.name } ${ m.id.abs } / ${ m.metadata.base.abs }`);
      if (m instanceof UnresolvedModule) {
        if (!/^javascript:alert\( 1(?: |%20)\)$/.test(m.id.abs.href)) {
          done(new Error(`Wrong id in ${ JSON.stringify(m) }`));
        } else {
          const resolutionPromise = moduleSet.onResolution(m);
          resolutionPromises.push(resolutionPromise);
          resolutionPromise.then((m) => messages.push(`${ m.constructor.name } ${ m.id.canon }`));
          if (requestCount === resolutionPromises.length) {
            Promise.all(resolutionPromises).then(wantResolved, fail);
          }
        }
      } else {
        done(new Error(`Got ${ m.constructor.name } not UnresolvedModule`));
      }
    }

    function wantResolved(results) {
      const got = JSON.parse(JSON.stringify(results, skipNull));
      const want = [
        {
          id: {
            abs: 'javascript:alert( 1 )',
            canon: 'javascript:alert(%201%20)',
          },
          source: 'alert( 1 )',
          metadata: {
            base: {
              // The base in the metadata is the first base from which it was fetched.
              abs: 'id:foo',
              canon: 'id:foo',
            },
            properties: {},
          },
        }
      ];
      want[3] = want[2] = want[1] = want[0];
      try {
        expect(want).to.deep.equal(got);
      } catch (ex) {
        done(ex);
        return;
      }

      // All should be aliases for the one canonical module
      try {
        expect(new Set(results).size).to.equal(1);
      } catch (ex) {
        done(ex);
        return;
      }

      // Check ordering of reports is sensible
      try {
        expect(messages).to.deep.equal([
          'UnresolvedModule javascript:alert( 1 ) / id:foo',
          'UnresolvedModule javascript:alert( 1%20) / id:foo',
          'UnresolvedModule javascript:alert( 1 ) / id:bar',
          'UnresolvedModule javascript:alert( 1 ) / id:bar',
          'ResolvedModule javascript:alert(%201%20)',
          'ResolvedModule javascript:alert(%201%20)',
          'ResolvedModule javascript:alert(%201%20)',
          'ResolvedModule javascript:alert(%201%20)',
        ]);
      } catch (ex) {
        done(ex);
        return;
      }
      messages.length = 0;

      done();
    }
  });
});
