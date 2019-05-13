/**
 * @fileoverview
 * function findImportsAndOutputs looks in an abstract-syntax tree for uses of
 * `import`, `export` and the CommonJS equivalents.
 */

import { LinkType, Stage } from './io';
import { BabelFileResult, Node, transformFromAstAsync, types } from '@babel/core';
import { NodePath } from '@babel/traverse';

export class SymbolFinding {
  remote: types.Identifier | 'default' | '*';
  local: types.Identifier | '*' | null;
  stage: Stage | null;

  constructor(
    remote: types.Identifier | 'default' | '*',
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
      : typeof this.remote !== 'string' && this.remote.loc
      ? this.remote.loc.start.line
      : null;
  }

  toJSON(): {
    remote: string, local: string | null, line: number | null, stage: Stage | null,
  } {
    return {
      remote: typeof this.remote === 'string' ? this.remote : this.remote.name,
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


export function findImportsExports(n: Node, out: ImportExportFinding[]):
Promise<BabelFileResult | null> {
  return transformFromAstAsync(
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
                          (idNode: types.Identifier, contextNodes: Node[]) => {
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
              console.log(JSON.stringify(path.node, null, 2));
              throw new Error('TODO' + path);
            },
          },
        },
      ],
    });
}

function destructure(p: Node, cb: (id: types.Identifier, context: Node[]) => void,
                     context: Node[] = []) {
  const len = context.length;
  switch (p.type) {
    case 'AssignmentPattern':
      // Assignment of a default value
      context[len] = p;
      destructure(p.left, cb, context);
      break;
    case 'Identifier':
      cb(p, context);
      break;
    case 'ObjectPattern':
      for (const property of p.properties) {
        destructure(property, cb);
      }
      break;
    case 'ObjectProperty':
      context[len] = p;
      destructure(p.value, cb, context);
      break;
    case 'ArrayPattern':
      for (const element of p.elements) {
        if (element) {
          destructure(element, cb);
        }
      }
      break;
    case 'RestElement':
      destructure(p.argument, cb);
      break;
    case 'MemberExpression':
    default:
      console.log(JSON.stringify(p, null, 2));
      throw new Error('TODO');
  }
  context.length = len;
}
