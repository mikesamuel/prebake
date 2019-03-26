'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const { inspect } = require('util');

const { ObjectGraph } = require('../lib/src/replayable');

/**
 * Separates a history (array of events) into an acyclic form that can be converted to JSON
 * and an array of distinct object values that can be tested by reference identity.
 *
 * @param og an object graph
 * @param startPoints an array of objects (or proxies to same) that need to persist.
 * @return { history, pool } where history are a series of events but without any seq field,
 *    with an extra origin field which points to the object created as a result of the event.
 *    Pool is an array of objects involved and should always include all startPoints.
 *    History is meant to be deeply comparable (per expect().to.deep.equals) and so object
 *    references are replaced with pointers into the pool of the form '#0#' where 0 is the
 *    pool index.
 */
function makeHistoryComparable(og, startPoints) {
  const events = og.serializeHistories(startPoints);

  // An array of nodes in the object-subgraph required to create startPoints.
  const pool = [];
  // Map pooled objects to indices (actually strings that show up well in test goldens)
  // in the pool array.
  const objToIndex = new Map();
  // Keys in events taht require special processing
  const valueIdentityKeys = new Set(['x', 'y', 'z', 'thisValue']);
  const valuesIdentityKeys = new Set(['args']);
  const otherKeys = new Set(['seq', 'type', 'p']);

  // Map seq numbers to the pool indices of the objects they originate
  const seqsReverse = Object.create(null);

  function fromPool(val) {
    val = og.unproxy(val);
    if (!objToIndex.has(val)) {
      const index = pool.length;
      const indexStr = `#${ index }#`;
      pool[index] = val;
      objToIndex.set(val, indexStr);
      const history = og.getHistory(val);
      if (history) {
        seqsReverse[history.origin.seq] = indexStr;
      }
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

  const history = JSON.parse(JSON.stringify(events, replace));
  startPoints.forEach(fromPool);

  for (let historyItem of history) {
    const { seq } = historyItem;
    const origin = seqsReverse[seq];
    if (origin) {
      historyItem.origin = origin;
    }
    delete historyItem.seq;
  }

  return { history, pool };
}

describe('replayable', () => {
  it('empty', () => {
    const og = new ObjectGraph();
    expect(og.serializeHistories([])).to.deep.equal([]);
  });
  it('empty want Object', () => {
    const og = new ObjectGraph();
    const globalProxy = og.getProxy(global);
    const objectProxy = globalProxy.Object;
    const { history, pool } = makeHistoryComparable(og, [objectProxy]);
    expect(history).to.deep.equal([
      {
        type: 'getGlobal',
        origin: '#0#',
      },
      {
        type: 'get',
        x: '#0#',
        p: 'Object',
        origin: '#1#',
      },
    ]);
    expect(pool.length).to.equal(2);
    expect(pool[0]).to.equal(global);
    expect(pool[1]).to.equal(Object);
  });
  it('empty want Number', () => {
    const og = new ObjectGraph();
    const globalProxy = og.getProxy(global);
    const numberProxy = globalProxy.Number;
    const { history, pool } = makeHistoryComparable(og, [numberProxy]);
    expect(history).to.deep.equal([
      {
        type: 'getGlobal',
        origin: '#0#',
      },
      {
        type: 'get',
        x: '#0#',
        p: 'Number',
        origin: '#1#',
      },
    ]);
    expect(pool.length).to.equal(2);
    expect(pool[0]).to.equal(global);
    expect(pool[1]).to.equal(Number);
  });
  it('empty fetched several, want Number', () => {
    const og = new ObjectGraph();
    const globalProxy = og.getProxy(global);
    globalProxy.Object;
    globalProxy.Array;
    const numberProxy = globalProxy.Number;
    const { history, pool } = makeHistoryComparable(og, [numberProxy]);
    expect(history).to.deep.equal([
      {
        type: 'getGlobal',
        origin: '#0#',
      },
      {
        type: 'get',
        x: '#0#',
        p: 'Number',
        origin: '#1#',
      },
    ]);
    expect(pool.length).to.equal(2);
    expect(pool[0]).to.equal(global);
    expect(pool[1]).to.equal(Number);
  });
  it('create object, set some fields', () => {
    const og = new ObjectGraph();
    const globalProxy = og.getProxy(global);
    const objectProxy = globalProxy.Object;

    const obj = new objectProxy();
    obj.x = 1;
    obj.y = 'str';

    const { history, pool } = makeHistoryComparable(og, [obj]);
    expect(history).to.deep.equal([
      {
        type: 'getGlobal',
        origin: '#0#',
      },
      // Find the Object constructor
      {
        type: 'get',
        x: '#0#',
        p: 'Object',
        origin: '#1#',
      },
      // Call the object constructor with zero arguments
      {
        type: 'construct',
        args: [],
        x: "#1#",
        origin: '#2#',
      },
      // Define some properties.
      {
        type: 'set',
        x: '#2#',
        p: 'x',
        y: 1,
      },
      {
        type: 'set',
        x: '#2#',
        p: 'y',
        y: 'str',
      },
    ]);
    expect(pool.length).to.equal(3);
    expect(pool[0]).to.equal(global);
    expect(pool[1]).to.equal(Object);
    expect(pool[2]).to.deep.equal({ x: 1, y: 'str' });
  });
  it('create function, call it', () => {
    const og = new ObjectGraph();
    const globalProxy = og.getProxy(global);
    const objectProxy = globalProxy.Object;

    const stackFrame = new objectProxy();
    stackFrame.x = 0;

    const builder = ((frame) => () => ++frame.x);
    const code = '(frame) => () => ++frame.x';
    const fnProxy = og.declareFunction(builder, code, [ stackFrame ]);

    // Call it several times.
    expect(fnProxy()).to.equal(1);
    expect(fnProxy()).to.equal(2);
    expect(fnProxy()).to.equal(3);

    const { history, pool } = makeHistoryComparable(og, [fnProxy]);
    expect(history).to.deep.equal([
      {
        type: 'getGlobal',
        origin: '#0#',
      },
      // Find the Object constructor
      {
        type: 'get',
        x: '#0#',
        p: 'Object',
        origin: '#1#',
      },
      // Call the object constructor with zero arguments to create a stack frame
      {
        type: 'construct',
        args: [],
        x: "#1#",
        origin: '#2#',
      },
      // Define a member on the stack frame
      {
        type: 'set',
        x: '#2#',
        p: 'x',
        y: 0,
      },
      // Now that we've got a stack frame, use it to bind a function.
      {
        type: 'codeBind',
        x: code,
        args: [ '#2#' ],
        origin: '#3#',
      },
      // Now there are three calls to the function.
      {
        type: 'set',
        x: '#2#',
        p: 'x',
        y: 1,
      },
      {
        type: 'set',
        x: '#2#',
        p: 'x',
        y: 2,
      },
      {
        type: 'set',
        x: '#2#',
        p: 'x',
        y: 3,
      },
    ]);
    expect(pool.length).to.equal(4);
    expect(pool[0]).to.equal(global);
    expect(pool[1]).to.equal(Object);
    expect(pool[2]).to.deep.equal({ x: 3 });
    const fn = og.unproxy(fnProxy);
    expect(typeof fn).to.equal('function');
    expect(pool[3]).to.equal(fn);
  });
  it('create via builtin apply', () => {
    // Objects created by parsing JSON.
    const jsonStr = '{ "x": { "y": [ 123, {} ] } }';

    const og = new ObjectGraph();
    const globalProxy = og.getProxy(global);

    const jsonProxy = globalProxy.JSON;
    const parsedOuterObj = jsonProxy.parse(jsonStr);
    const parsedInnerObj = parsedOuterObj.x;
    const parsedArr = parsedInnerObj.y;

    const { history, pool } = makeHistoryComparable(og, [parsedInnerObj, parsedArr]);
    expect(history).to.deep.equal([
      {
        type: 'getGlobal',
        origin: '#0#',
      },
      {
        type: 'get',
        x: '#0#',
        p: 'JSON',
        origin: '#1#',
      },
      {
        type: 'get',
        x: '#1#',
        p: 'parse',
        origin: '#2#',
      },
      {
        type: 'apply',
        x: '#2#',
        thisValue: '#1#',
        args: [ jsonStr ],
        origin: '#3#',
      },
      {
        type: 'get',
        x: '#3#',
        p: 'x',
        origin: '#4#',
      },
      {
        type: 'get',
        x: '#4#',
        p: 'y',
        origin: '#5#',
      },
    ]);
    expect(pool.length).to.equal(6);
    expect(pool[0]).to.equal(global);
    expect(pool[1]).to.equal(JSON);
    expect(pool[2]).to.equal(JSON.parse);
    expect(pool[3]).to.deep.equal({ "x": pool[4] });
    expect(pool[4]).to.deep.equal({ "y": [ 123, {} ] });
    expect(pool[5]).to.deep.equal([ 123, {} ]);
  });
});


// TODO: test JSON.parse with a reviver that is a declared function and test that
//   x = JSON.parse('[ { "type": "Date", "millis": 123456789 } ]', reviverThatCreatesDates);
// and make sure that, though the origin is a call to reviverThatCreatesDates
// that the reviver is not called twice and x[0] === the value from the only call.
