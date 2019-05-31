/**
 * @fileoverview
 * Options used to parse prebakeable modules.
 */

import { TransformOptions } from '@babel/core';

export const parseOptions: TransformOptions = {
  plugins: [
    '@babel/plugin-syntax-dynamic-import',
    '@babel/plugin-proposal-export-namespace-from',
  ],
//  comments: true,
  sourceType: 'unambiguous',
};
