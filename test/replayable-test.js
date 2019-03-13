'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');

const { ObjectGraph } = require('../lib/src/replayable');

/**
 * Separates a history (array of events) into an acyclic form that can be converted to JSON
 * and an array of distinct object values that can be tested by reference identity.
 */
function makeHistoryComparable(events) {
  const pool = [];
  const objToIndex = new Map();
  const valueIdentityKeys = new Set(['x', 'y', 'z', 'thisValue']);
  const valuesIdentityKeys = new Set(['args']);
  const otherKeys = new Set(['seq', 'type', 'p']);

  function fromPool(val) {
    if (!objToIndex.has(val)) {
      const index = pool.length;
      pool[index] = val;
      objToIndex.set(val, `#${ index }#`);
    }
    return objToIndex.get(val);
  }

  function replace(key, val) {
    if (!key || !val || (typeof val !== 'object' && typeof val !== 'function')) {
      return val;
    }
    if (valueIdentityKeys.has(key)) {
      return fromPool(val);
    } else if (valuesIdentityKeys.has(key) && Array.isArray(val)) {
      const vals = [];
      for (let i = 0, n = val.length; i < n; ++i) {
        const el = val[i];
        vals[i] = (el && (typeof el === 'object' || typeof el === 'function'))
          ? fromPool(el)
          : el;
      }
      return vals;
    } else if (+key === +key || otherKeys.has(key)) {
      return val;
    } else {
      throw new Error(key);
    }
  }

  return { history: JSON.parse(JSON.stringify(events, replace)), pool };
}

describe('cases', () => {
  it('empty', () => {
    const og = new ObjectGraph();
    expect(og.serializeHistories([])).to.deep.equal([
    ]);
  });
  it('empty want Object', () => {
    const og = new ObjectGraph();
    const objectProxy = og.getProxy(global).Object;
    const { history, pool } = makeHistoryComparable(og.serializeHistories([objectProxy]));
    expect(history).to.deep.equal([
      {
        seq: 0,
        type: 'getGlobal'
      },
      {
        seq: 1,
        type: 'get',
        x: '#0#',
        p: 'Object',
        y: '#1#'
      },
    ]);
    expect(pool[0]).to.equal(global);
    // TODO: What is object 1?
    expect(pool.length).to.equal(2);
  });
  it('empty want Number', () => {
    const og = new ObjectGraph();
    const numberProxy = og.getProxy(global).Number;
    const { history, pool } = makeHistoryComparable(og.serializeHistories([numberProxy]));
    expect(history).to.deep.equal([
      {
        seq: 0,
        type: 'getGlobal'
      },
      {
        seq: 4,
        type: 'get',
        x: '#0#',
        p: 'Number',
        y: '#1#'
      },
    ]);
    expect(pool[0]).to.equal(global);
    // TODO: What is object 1?
    expect(pool.length).to.equal(2);
  });
  it('empty fetched several, want Number', () => {
    const og = new ObjectGraph();
    og.getProxy(global).Object;
    og.getProxy(global).Array;
    const numberProxy = og.getProxy(global).Number;
    const { history, pool } = makeHistoryComparable(og.serializeHistories([numberProxy]));
    expect(history).to.deep.equal([
      {
        seq: 0,
        type: 'getGlobal'
      },
      {
        seq: 4,
        type: 'get',
        x: '#0#',
        p: 'Number',
        y: '#1#'
      },
    ]);
    expect(pool[0]).to.equal(global);
    // TODO: What is object 1?
    expect(pool.length).to.equal(2);
  });
});
