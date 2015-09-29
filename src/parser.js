import lineColumnMapper from './util/lineColumnMapper';
import parseLiteral from './util/parseLiteral';
import { nodes as csParse } from 'coffee-script';

/**
 * @param source
 * @returns {Program}
 */
export function parse(source) {
  if (source.length === 0) {
    return /** @type Program */ {
      type: 'Program',
      line: 1,
      column: 1,
      raw: source,
      range: [0, 0],
      body: null
    };
  }

  return /** @type Program */ convert(csParse(source), source, lineColumnMapper(source));
}

function locationContainingNodes(...nodes) {
  switch (nodes.length) {
    case 0:
      return null;

    case 1:
      return nodes[0].locationData;

    case 2:
      return mergeLocations(nodes[0].locationData, nodes[1].locationData);

    default:
      return mergeLocations(nodes[0].locationData, locationContainingNodes(...nodes.slice(1)));
  }
}

function mergeLocations(left, right) {
  let first_line;
  let first_column;
  let last_line;
  let last_column;

  if (left.first_line < right.first_line) {
    ({ first_line, first_column } = left);
  } else if (left.first_line > right.first_line) {
    ({ first_line, first_column } = right);
  } else if (left.first_column < right.first_column) {
    ({ first_line, first_column } = left);
  } else {
    ({ first_line, first_column } = right);
  }

  if (left.last_line < right.last_line) {
    ({ last_line, last_column } = right);
  } else if (left.last_line > right.last_line) {
    ({ last_line, last_column } = left);
  } else if (left.last_column < right.last_column) {
    ({ last_line, last_column } = right);
  } else {
    ({ last_line, last_column } = left);
  }

  return { first_line, first_column, last_line, last_column };
}

/**
 * @param {Object} node
 * @param {string} source
 * @param {function(number, number): number} mapper
 * @param ancestors
 * @returns {Node}
 */
function convert(node, source, mapper, ancestors=[]) {
  if (ancestors.length === 0) {
    return makeNode('Program', node.locationData, {
      body: makeNode('Block', node.locationData, {
        statements: node.expressions.map(convertChild)
      })
    });
  }

  switch (type(node)) {
    case 'Value':
      let value = convertChild(node.base);
      node.properties.forEach(prop => {
        value = accessOpForProperty(value, prop, node.base.locationData);
      });
      return value;

    case 'Literal':
      if (/^\d+|(\d+)?\.\d+$/.test(node.value)) {
        const data = JSON.parse(node.value);
        return makeNode(nodeTypeForLiteral(data), node.locationData, { data });
      } else if (node.value === 'this') {
        return makeNode('This', node.locationData);
      } else {
        const data = parseLiteral(node.value);
        if (typeof data === 'string') {
          return makeNode('String', node.locationData, { data });
        }
        return makeNode('Identifier', node.locationData, { data: node.value });
      }

    case 'Call':
      return makeNode('FunctionApplication', node.locationData, {
        function: convertChild(node.variable),
        arguments: node.args.map(convertChild)
      });

    case 'Op':
      return convertOperator(node);

    case 'Assign':
      if (node.context === 'object') {
        return makeNode('ObjectInitialiserMember', node.locationData, {
          key: convertChild(node.variable),
          expression: convertChild(node.value)
        });
      } else {
        return makeNode('AssignOp', node.locationData, {
          assignee: convertChild(node.variable),
          expression: convertChild(node.value)
        });
      }

    case 'Obj':
      return makeNode('ObjectInitialiser', node.locationData, {
        members: node.properties.map(property => {
          if (type(property) === 'Value') {
            // shorthand property
            const keyValue = convertChild(property);
            return makeNode('ObjectInitialiserMember', property.locationData, {
              key: keyValue,
              expression: keyValue
            });
          }

          return convertChild(property);
        })
      });

    case 'Arr':
      return makeNode('ArrayInitialiser', node.locationData, {
        members: node.objects.map(convertChild)
      });

    case 'Parens':
      return convertChild(node.body.expressions[0]);

    case 'If':
      if (type(node.condition) === 'Op' && node.condition.operator === '!') {
        if (node.locationData === node.condition.locationData) {
          // Virtual node for `unless` condition.
          node.condition.locationData = null;
        }
      }
      return makeNode('Conditional', node.locationData, {
        condition: convertChild(node.condition),
        consequent: convertChild(node.body),
        alternate: node.elseBody ? convertChild(node.elseBody) : null
      });

    case 'Code':
      return makeNode(node.bound ? 'BoundFunction' : 'Function', node.locationData, {
        body: node.body ? convertChild(node.body) : null,
        parameters: node.params.map(convertChild)
      });

    case 'Param':
      const param = convertChild(node.name);
      if (node.value) {
        return makeNode('DefaultParam', node.locationData, {
          default: convertChild(node.value),
          param
        });
      }
      return param;

    case 'Block':
      if (node.expressions.length === 0) {
        return null;
      } else {
        return makeNode('Block', node.locationData, {
          statements: node.expressions.map(convertChild)
        });
      }

    case 'Bool':
      return makeNode('Bool', node.locationData, {
        data: JSON.parse(node.val)
      });

    case 'Null':
      return makeNode('Null', node.locationData);

    case 'While':
      return makeNode('While', locationContainingNodes(node, node.condition, node.body), {
        condition: convertChild(node.condition),
        body: convertChild(node.body)
      });

    case 'Class':
      const nameNode = node.variable ? convertChild(node.variable) : null;

      let ctor = null;
      let boundMembers = [];
      const body = (!node.body || node.body.expressions.length === 0) ? null : makeNode('Block', node.body.locationData, {
        statements: node.body.expressions.reduce((statements, expr) => {
          if (type(expr) === 'Value' && type(expr.base) === 'Obj') {
            expr.base.properties.forEach(property => {
              let key;
              let value;
              if (type(property) === 'Value') {
                // shorthand property
                key = value = convertChild(property);
              } else {
                key = convertChild(property.variable);
                value = convertChild(property.value);
              }
              if (key.data === 'constructor') {
                statements.push(ctor = makeNode('Constructor', property.locationData, {
                  expression: value
                }));
              } else if (key.type === 'MemberAccessOp' && key.expression.type === 'This') {
                statements.push(makeNode('AssignOp', property.locationData, {
                  assignee: key,
                  expression: value
                }));
              } else {
                statements.push(makeNode('ClassProtoAssignOp', property.locationData, {
                  assignee: key,
                  expression: value
                }));
              }
              if (value.type === 'BoundFunction') {
                boundMembers.push(statements[statements.length - 1]);
              }
            });
          } else {
            statements.push(convertChild(expr));
          }
          return statements;
        }, [])
      });

      return makeNode('Class', node.locationData, {
        name: nameNode,
        nameAssignee: nameNode,
        body,
        boundMembers,
        parent: node.parent ? convertChild(node.parent) : null,
        ctor
      });

    case 'Switch':
      return makeNode('Switch', node.locationData, {
        expression: convertChild(node.subject),
        cases: node.cases.map(([conditions, body]) => {
          if (!Array.isArray(conditions)) {
            conditions = [conditions];
          }
          const loc = expandLocationLeftThrough(
            locationContainingNodes(conditions[0], body),
            'when '
          );
          return makeNode('SwitchCase', loc, {
            conditions: conditions.map(convertChild),
            consequent: convertChild(body)
          })
        }),
        alternate: node.otherwise ? convertChild(node.otherwise) : null
      });

    default:
      throw new Error(`unknown node type: ${type(node)}\n${JSON.stringify(node, null, 2)}`);
      break;
  }

  function convertChild(child) {
    return convert(child, source, mapper, [...ancestors, node]);
  }

  function makeNode(type, loc, attrs={}) {
    const result = { type };
    if (loc) {
      const start = mapper(loc.first_line, loc.first_column);
      const end = mapper(loc.last_line, loc.last_column) + 1;
      result.line = loc.first_line + 1;
      result.column = loc.first_column + 1;
      result.range = [start, end];
    } else {
      result.virtual = true;
    }
    for (let key in attrs) {
      if (attrs.hasOwnProperty(key)) {
        let value = attrs[key];
        result[key] = value;
        if (value && result.range) {
          (Array.isArray(value) ? value : [value]).forEach(node => {
            if (node.range) {
              // Expand the range to contain all the children.
              if (result.range[0] > node.range[0]) {
                result.range[0] = node.range[0];
              }
              if (result.range[1] < node.range[1]) {
                result.range[1] = node.range[1];
              }
            }
          });
        }
      }
    }
    // Shrink to be within the size of the source.
    if (result.range) {
      if (result.range[0] < 0) {
        result.range[0] = 0;
      }
      if (result.range[1] > source.length) {
        result.range[1] = source.length;
      }
      result.raw =  source.slice(result.range[0], result.range[1]);
    }
    return result;
  }

  /**
   * @param expression converted base
   * @param prop CS node to convert
   * @param loc CS location data for original base
   */
  function accessOpForProperty(expression, prop, loc) {
    switch (type(prop)) {
      case 'Access':
        return makeNode('MemberAccessOp', mergeLocations(loc, prop.locationData), {
          expression,
          memberName: prop.name.value
        });

      case 'Index':
        return makeNode('DynamicMemberAccessOp', expandLocationRightThrough(mergeLocations(loc, prop.locationData), ']'), {
          expression,
          indexingExpr: convert(prop.index, source, mapper, [...ancestors, node, prop])
        });

      default:
        throw new Error(`unknown property type: ${type(prop)}\n${JSON.stringify(prop, null, 2)}`)
    }
  }

  function convertOperator(op) {
    let nodeType;

    if (op.second) {
      switch (op.operator) {
        case '+':
          nodeType = 'PlusOp';
          break;

        case '-':
          nodeType = 'SubtractOp';
          break;

        case '*':
          nodeType = 'MultiplyOp';
          break;

        case '/':
          nodeType = 'DivideOp';
          break;

        case '%':
          nodeType = 'RemOp';
          break;
      }

      return makeNode(nodeType, op.locationData, {
        left: convert(op.first, source, mapper, [...ancestors, op]),
        right: convert(op.second, source, mapper, [...ancestors, op])
      });
    } else {
      switch (op.operator) {
        case '+':
          nodeType = 'UnaryPlusOp';
          break;

        case '-':
          nodeType = 'UnaryNegateOp';
          break;

        case 'typeof':
          nodeType = 'TypeofOp';
          break;
      }

      return makeNode(nodeType, op.locationData, {
        expression: convert(op.first, source, mapper, [...ancestors, op])
      });
    }
  }

  function expandLocationRightThrough(loc, string) {
    let offset = mapper(loc.last_line, loc.last_column) + 1;
    offset = source.indexOf(string, offset);

    if (offset < 0) {
      throw new Error(
        `unable to expand location ending at ${loc.last_line + 1}:${loc.last_column + 1} ` +
        `because it is not followed by ${JSON.stringify(string)}`
      );
    }

    const newLoc = mapper.invert(offset + string.length - 1);

    return {
      first_line: loc.first_line,
      first_column: loc.first_column,
      last_line: newLoc.line,
      last_column: newLoc.column
    };
  }

  function expandLocationLeftThrough(loc, string) {
    let offset = mapper(loc.first_line, loc.first_column);
    offset = source.lastIndexOf(string, offset);

    if (offset < 0) {
      throw new Error(
        `unable to expand location starting at ${loc.first_line + 1}:${loc.first_column + 1} ` +
        `because it is not preceded by ${JSON.stringify(string)}`
      );
    }

    const newLoc = mapper.invert(offset);

    return {
      first_line: newLoc.line,
      first_column: newLoc.column,
      last_line: loc.last_line,
      last_column: loc.last_column
    };
  }
}

function type(node) {
  return node.constructor.name;
}

function nodeTypeForLiteral(value) {
  switch (typeof value) {
    case 'number':
      return Math.floor(value) === value ? 'Int' : 'Float';

    default:
      throw new Error(`unimplemented node type for ${JSON.stringify(value)}`);
  }
}


