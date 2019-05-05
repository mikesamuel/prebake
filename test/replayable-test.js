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
    } else if (key === 'desc') {
      if ('value' in val) {
        const value = val.value;
        if (value && typeof value === 'object') {
          val.value = fromPool(value);
        }
      } else {
        if ('get' in val) {
          val.get = fromPool(val.get);
        }
        if ('set' in val) {
          val.set = fromPool(val.set);
        }
      }
      return val;
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
  it('get a property descriptor', () => {
    const og = new ObjectGraph();
    const globalProxy = og.getProxy(global);
    const reflectProxy = globalProxy.Reflect;

    const o = new globalProxy.Object();
    o.x = o;

    let descriptor = reflectProxy.getOwnPropertyDescriptor(o, 'x');

    const { history, pool } = makeHistoryComparable(og, [descriptor]);
    expect(history).to.deep.equal([
      {
        type: 'getGlobal',
        origin: '#0#',
      },
      {
        type: 'get',
        x: '#0#',
        p: 'Object',
        origin: '#1#',  // #1# = global.Object
      },
      {
        type: 'get',
        x: '#0#',
        p: 'Reflect',
        origin: '#3#',  // #3# = global.Reflect
      },
      {
        type: 'construct',
        x: '#1#',
        args: [],
        origin: '#2#',  // #2# = new Object()
      },
      {
        type: 'set',
        x: '#2#',
        p: 'x',
        y: '#2#',
        // #2#.x = #2#
      },
      {
        type: 'get',
        x: '#3#',
        p: 'getOwnPropertyDescriptor',
        origin: '#4#',  // #4# = global.Reflect.getOwnPropertyDescriptor
      },
      {
        type: 'apply',
        x: '#4#',
        thisValue: '#3#',
        args: [
          '#2#',
          'x',
        ],
        origin: '#5#',  // #5# = Reflect.getOwnPropertyDescriptor(#2#, 'x')
      },
    ]);
    expect(pool.length).to.equal(6);
    expect(pool[0]).to.equal(global);
    expect(pool[1]).to.equal(Object);
    expect(pool[2]).to.equal(og.unproxy(o));
    expect(pool[3]).to.equal(Reflect);
    expect(pool[4]).to.equal(Reflect.getOwnPropertyDescriptor);
    expect(pool[5]).to.equal(og.unproxy(descriptor));
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
        p: 'Object',
        origin: '#1#',
      },
      {
        type: 'get',
        x: '#0#',
        p: 'Array',
        origin: '#2#',
      },
      {
        // Create an object
        type: 'construct',
        x: '#1#',
        args: [],
        origin: '#5#',
      },
      {
        // Create an array
        type: 'construct',
        x: '#2#',
        args: [],
        origin: '#3#',
      },
      {
        // Create another object
        type: 'construct',
        x: '#1#',
        args: [],
        origin: '#4#',
      },
      {
        // Assign element 0 of the array
        type: 'defineProperty',
        x: '#3#',
        p: '0',
        desc: {
          configurable: true,
          enumerable: true,
          writable: true,
          value: 123,
        },
      },
      {
        // Assign element 1 of the array to the inner object
        type: 'defineProperty',
        x: '#3#',
        p: '1',
        desc: {
          configurable: true,
          enumerable: true,
          writable: true,
          value: '#4#',
        },
      },
      {
        // Put the array in the outer object
        type: 'defineProperty',
        x: '#5#',
        p: 'y',
        desc: {
          configurable: true,
          enumerable: true,
          writable: true,
          value: '#3#',
        },
      },
    ]);
    expect(pool.length).to.equal(6);
    expect(pool[0]).to.equal(global);
    expect(pool[1]).to.equal(Object);
    expect(pool[2]).to.equal(Array);
    expect(pool[3]).to.deep.equal([ 123, {} ]);
    expect(pool[4]).to.equal(og.unproxy(pool[3][1]));
    expect(pool[5]).to.deep.equal({ "y": pool[3] });
  });
  it('JSON.parse with reviver', () => {
    // A JSON reviver can create values which then become part of the output
    // without there being an explicit record of inner object creation or
    // property assignments.

    const og = new ObjectGraph();
    const globalProxy = og.getProxy(global);

    const jsonProxy = globalProxy.JSON;

    const jsonToParse = '[ { "type": "Date", "millis": 946684800000 } ]';

    // A reviver that turns { type: 'Date', millis } into builtin Date values
    const reviverBuilder = (stackFrame) => {
      return function (key, val) {
        if (val && typeof val === 'object' && !stackFrame.Array.isArray(val)) {
          if (val.type === 'Date' && typeof val.millis === 'number') {
            return new stackFrame.Date(val.millis);
          }
        }
        return val;
      };
    };

    const reviverCode = `
      function (key, val) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          if (val.type === 'Date' && typeof val.millis === 'number') {
            return new Date(val.millis);
          }
        }
        return val;
      }`;

    const reviverProxy = og.declareFunction(
      reviverBuilder,
      reviverCode,
      [ globalProxy ]);

    const arrayOfDatesProxy = jsonProxy.parse(jsonToParse, reviverProxy);
    const revivedDateProxy = arrayOfDatesProxy[0];
    expect(Array.isArray(arrayOfDatesProxy) && arrayOfDatesProxy.length === 1);
    expect(revivedDateProxy instanceof Date);

    const { history, pool } = makeHistoryComparable(
      og, [revivedDateProxy, arrayOfDatesProxy]);
    expect(history).to.deep.equal([
      {
        type: 'getGlobal',
        origin: '#0#',
      },
      {
        type: 'get',
        x: '#0#',
        p: 'Array',
        origin: '#1#',
      },
      {
        type: 'construct',
        x: '#1#',
        args: [],
        origin: '#3#',
        // #3# = new Array()
      },
      {
        type: 'get',
        x: '#0#',
        p: 'Date',
        origin: '#2#',
      },
      {
        type: 'construct',
        x: '#2#',
        args: [ 946684800000 ],
        origin: '#4#',
        // #4# = new Date(946684800000)
      },
      {
        type: 'defineProperty',
        x: '#3#',
        p: '0',
        desc: {
          configurable: true,
          enumerable: true,
          writable: true,
          value: '#4#',
        },
        // #3#[0] = #4#
      }
    ]);
    expect(pool.length).to.equal(5);
    expect(pool[0]).to.equal(global);
    expect(pool[1]).to.equal(Array);
    expect(pool[2]).to.equal(Date);
    expect(pool[3]).to.equal(og.unproxy(arrayOfDatesProxy));
    expect(pool[4] instanceof Date).to.equal(true);
    expect(+pool[4]).to.equal(946684800000);
  });
});
