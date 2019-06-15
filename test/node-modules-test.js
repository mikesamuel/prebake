'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');

const { isBuiltin } = require('../lib/src/node-modules.js');

describe('node-modules', () => {
  describe('isBuiltin', () => {
    it('url is builtin', () => {
      expect(isBuiltin('url')).equals(true);
    });
    it('this module is not', () => {
      expect(isBuiltin(__filename)).equals(false);
    });
    it('chai is not', () => {
      expect(isBuiltin('chai')).equals(false);
    });
  });
});
