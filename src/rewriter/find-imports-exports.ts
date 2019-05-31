/**
 * @fileoverview
 * function findImportsAndOutputs looks in an abstract-syntax tree for uses of
 * `import`, `export` and the CommonJS equivalents.
 */

import { LinkType, Stage } from './io';
import { Node, transformFromAstAsync, types } from '@babel/core';
import { NodePath } from '@babel/traverse';

export class SymbolFinding {
  remote: types.Identifier | 'default' | '*' | null;
  local: types.Identifier | '*' | null;
  stage: Stage | null;

  constructor(
    remote: types.Identifier | 'default' | '*' | null,
    local: types.Identifier | '*' | null,
    stage: Stage | null
  ) {
    this.remote = remote;
    this.local = local;
    this.stage = stage;
  }

  get linenum() {
    return typeof this.local !== 'string' && this.local && this.local.loc
      ? this.local.loc.start.line
      : typeof this.remote !== 'string' && this.remote && this.remote.loc
      ? this.remote.loc.start.line
      : null;
  }

  toJSON(): {
    remote: string | null, local: string | null, line: number | null, stage: Stage | null,
  } {
    return {
      remote: typeof this.remote === 'string' ? this.remote : this.remote ? this.remote.name : null,
      local: typeof this.local === 'string' ? this.local : this.local ? this.local.name : null,
      line: this.linenum,
      stage: this.stage,
    };
  }
}

export class ImportExportFinding {
  findingType: 'import' | 'export';
  linkType: LinkType;
  moduleSpecifier: types.StringLiteral | null;
  symbols: SymbolFinding[];

  constructor(
    findingType: 'import' | 'export',
    linkType: LinkType,
    moduleSpecifier: types.StringLiteral | null,
    symbols: SymbolFinding[]
  ) {
    this.findingType = findingType;
    this.linkType = linkType;
    this.moduleSpecifier = moduleSpecifier;
    this.symbols = symbols;
  }

  toJSON() {
    return {
      findingType: this.findingType,
      linkType: this.linkType,
      moduleSpecifier: this.moduleSpecifier ? this.moduleSpecifier.value : null,
      symbols: this.symbols,
    };
  }
}


function stageFromComments(comments: ReadonlyArray<types.Comment> | null): Stage | null {
  let stage: Stage | null = null;
  if (comments && comments.length) {
    const comment = comments[comments.length - 1];
    comment.value.replace(/@prebake.(\w+)/g, (whole, term) => {
      switch (term) {
        case 'moot':
        case 'eager':
        case 'runtime':
          stage = term;
          break;
      }
      return whole;
    });
  }
  return stage;
}


export async function findImportsExports(n: Node): Promise<ImportExportFinding[]> {
  const processed: Set<Node> = new Set();

  function isRequire(node: Node, path: NodePath) {
    return node.type === 'CallExpression' && node.callee.type === 'Identifier'
      && node.callee.name === 'require' && node.arguments.length
      && node.arguments[0].type === 'StringLiteral' && !path.scope.hasBinding('require');
  }

  const out: ImportExportFinding[] = [];
  await transformFromAstAsync(
    n,
    undefined,
    {
      code: false,
      ast: true,
      plugins: [
        {
          visitor: {
            // github.com/babel/babylon/blob/master/ast/spec.md#imports
            ImportDeclaration(path: NodePath) {
              const { specifiers, source } = path.node as types.ImportDeclaration;
              const symbols = [];
              for (const specifier of specifiers) {
                const { local } = specifier;

                const stage = stageFromComments(local.leadingComments || specifier.leadingComments);

                switch (specifier.type) {
                  case 'ImportSpecifier':
                    const { imported } = specifier;
                    symbols.push(new SymbolFinding(imported, local, stage));
                    continue;
                  case 'ImportDefaultSpecifier':
                    symbols.push(new SymbolFinding('default', local, stage));
                    continue;
                  case 'ImportNamespaceSpecifier':
                    symbols.push(new SymbolFinding('*', local, stage));
                    continue;
                  default:
                    throw new Error(JSON.stringify(specifier));
                }
              }
              out.push(new ImportExportFinding('import', 'esm', source, symbols));
            },
            // github.com/babel/babylon/blob/master/ast/spec.md#exports
            ExportNamedDeclaration(path: NodePath) {
              const { declaration, source, specifiers } = path.node as types.ExportNamedDeclaration;
              const symbols = [];
              if (declaration) {
                switch (declaration.type) {
                  case 'VariableDeclaration':
                    for (const declarator of declaration.declarations) {
                      if (declarator.id.type === 'Identifier') {
                        const stage = stageFromComments(
                          declarator.id.leadingComments || declarator.leadingComments);
                        symbols.push(new SymbolFinding(declarator.id, declarator.id, stage));
                      } else {
                        destructure(
                          declarator.id,
                          (idNode: types.Identifier,
                           // @ts-ignore unused
                           left, depth,
                           contextNodes: Node[]) => {
                            let { leadingComments } = idNode;
                            for (let i = 0, n = contextNodes.length;
                                 !leadingComments && i < n; ++i) {
                              ({ leadingComments } = contextNodes[i]);
                            }
                            const stage = stageFromComments(leadingComments);
                            symbols.push(new SymbolFinding(idNode, null, stage));
                          });
                      }
                    }
                    break;
                  case 'FunctionDeclaration':
                    const id = declaration.id;
                    if (id) {
                      const stage = stageFromComments(
                        id.leadingComments || declaration.leadingComments);
                      symbols.push(new SymbolFinding(id, id, stage));
                    } else {
                      throw new Error('FunctionDeclaration missing id');
                    }
                    break;
                  default:
                    throw new Error(declaration.type);
                }
              }
              for (const specifier of specifiers) {
                const { exported } = specifier;

                const stage = stageFromComments(
                  exported.leadingComments || specifier.leadingComments);

                switch (specifier.type) {
                  case 'ExportSpecifier':
                    const { local } = specifier;
                    symbols.push(new SymbolFinding(exported, local, stage));
                    continue;
                  case 'ExportDefaultSpecifier':
                    throw new Error();
                    // continue;
                  case 'ExportNamespaceSpecifier':
                    symbols.push(new SymbolFinding(exported, '*', stage));
                    continue;
                  default:
                    throw new Error(JSON.stringify(specifier));
                }
              }
              out.push(new ImportExportFinding('export', 'esm', source, symbols));
            },
            ExportDefaultDeclaration(path: NodePath) {
              const node = path.node as types.ExportDefaultDeclaration;
              const stage = stageFromComments(
                node.declaration.leadingComments || node.leadingComments);
              const symbols = [ new SymbolFinding('default', null, stage) ];
              out.push(new ImportExportFinding('export', 'esm', null, symbols));
            },
            ExportAllDeclaration(path: NodePath) {
              console.log(JSON.stringify(path.node, (k, v) => k === 'loc' ? undefined : v, 2));
              throw new Error('TODO' + path);
            },
            CallExpression(path: NodePath) {
              const node = path.node as types.CallExpression;
              if (isRequire(node, path) && !processed.has(node)) {
                const target = node.arguments[0] as types.StringLiteral;
                const symbols: SymbolFinding[] = [];
                if (path.parentPath) {
                  const parent = path.parentPath.node;
                  let left = null;
                  if (parent.type === 'VariableDeclarator') {
                    left = parent.id;
                  } // TODO: AssignmentExpression

                  if (left) {
                    if (left.type === 'Identifier') {
                      const stage = stageFromComments(
                        left.leadingComments || parent.leadingComments);
                      symbols.push(new SymbolFinding('*', left as types.Identifier, stage));
                    } else {
                      destructure(
                        left,
                        (local, left, depth, contextNodes) => {
                          let { leadingComments } = local;
                          for (let i = 0, n = contextNodes.length;
                               !leadingComments && i < n; ++i) {
                            ({ leadingComments } = contextNodes[i]);
                          }
                          const remote = depth === 1 ? left : null;
                          const stage = stageFromComments(leadingComments);
                          symbols.push(new SymbolFinding(remote, local, stage));
                        });
                    }
                  }
                }
                out.push(new ImportExportFinding('import', 'cjs', target, symbols));
              }
            },
            AssignmentExpression(path: NodePath) {
              const node = path.node as types.AssignmentExpression;
              if (node.operator !== '=' || node.left.type !== 'MemberExpression') {
                return;
              }

              function isModuleDotExports(e: types.Expression) {
                return e.type === 'MemberExpression'
                  && e.object.type === 'Identifier'
                  && e.object.name === 'module'
                  && e.property.type === 'Identifier'
                  && e.property.name === 'exports'
                  && !path.scope.hasBinding('module');
              }

              const { left, right } = node;
              if (isModuleDotExports(left)) {
                // module.exports = ...;
                if (right.type === 'ObjectExpression') {
                  const symbols: SymbolFinding[] = [];
                  for (const property of right.properties) {
                    switch (property.type) {
                      case 'ObjectMethod':
                      case 'ObjectProperty': {
                        const { computed, key } = property;
                        if (!computed && key.type === 'Identifier') {
                          const stage = stageFromComments(
                            key.leadingComments || property.leadingComments);
                          if (property.type === 'ObjectProperty') {
                            const value = property.value;
                            if (isRequire(value, path)) {  // Namespace export
                              const call = value as types.CallExpression;
                              processed.add(call);
                              out.push(new ImportExportFinding(
                                'export', 'cjs', (call.arguments[0] as types.StringLiteral),
                                [
                                  new SymbolFinding(key, '*', stage),
                                ]));
                              break;
                            }
                          }
                          symbols.push(new SymbolFinding(key, null, stage));
                        }
                        break;
                      }
                      case 'SpreadElement': {
                        const { argument } = property;
                        if (isRequire(argument, path)) {
                          const call = argument as types.CallExpression;
                          processed.add(call);
                          const stage = stageFromComments(
                            argument.leadingComments || property.leadingComments);
                          out.push(new ImportExportFinding(
                            'export', 'cjs', (call.arguments[0] as types.StringLiteral),
                            [
                              new SymbolFinding('*', '*', stage),
                            ]));
                        }
                        break;
                      }
                      default:
                        throw new Error((property as Node).type);
                    }
                  }
                  out.push(new ImportExportFinding('export', 'cjs', null, symbols));
                } else {
                  console.log(JSON.stringify(node, (k, v) => k === 'loc' ? undefined : v, 2));
                }
              } else if (left.type === 'MemberExpression'
                         && isModuleDotExports(left.object)) {
                // module.exports.foo = ...;
                if (left.property.type === 'Identifier') {
                  const stage = stageFromComments(
                    left.property.leadingComments
                      || left.leadingComments
                      || node.leadingComments);
                  const symbol = new SymbolFinding(left.property, null, stage);
                  out.push(new ImportExportFinding('export', 'cjs', null, [symbol]));
                }
              }
            },
          },
        },
      ],
    });
  return out;
}

function destructure(
  // The node to destructure
  p: Node,
  // A callback that receives
  cb: (id: types.Identifier,
       left: types.Identifier | '*' | null,
       depth: number,
       context: Node[]) => void,
  // Number of objects or array patterns surrounding p.
  depth = 0,
  // The name of the property in the innermost object or array.
  left: types.Identifier | '*' | null = null,
  // Nodes that contain p and do not have a token before the start of p.
  context: Node[] = []) {
  const len = context.length;
  switch (p.type) {
    case 'AssignmentPattern': {
      // Assignment of a default value
      context[len] = p;
      destructure(p.left, cb, depth, null, context);
      break;
    }
    case 'Identifier':
      cb(p, left, depth, context);
      break;
    case 'ObjectPattern':
      for (const property of p.properties) {
        destructure(property, cb, depth + 1);
      }
      break;
    case 'ObjectProperty': {
      context[len] = p;
      const leftId = p.key.type === 'Identifier' ? p.key as types.Identifier : null;
      destructure(p.value, cb, depth, leftId, context);
      break;
    }
    case 'ArrayPattern':
      for (const element of p.elements) {
        if (element) {
          destructure(element, cb, depth + 1);
        }
      }
      break;
    case 'RestElement':
      destructure(p.argument, cb, depth, '*');
      break;
    case 'MemberExpression':
    default:
      console.log(JSON.stringify(p, null, 2));
      throw new Error('TODO ' + p.type);
  }
  context.length = len;
}
