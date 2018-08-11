/**
 * @author Toru Nagashima <https://github.com/mysticatea>
 * @copyright 2017 Toru Nagashima. All rights reserved.
 * See LICENSE file in root directory for full license.
 */
import first from "lodash/first"
import last from "lodash/last"
import sortedIndexBy from "lodash/sortedIndexBy"
import {
    traverseNodes,
    ESLintArrayPattern,
    ESLintCallExpression,
    ESLintExpression,
    ESLintExpressionStatement,
    ESLintExtendedProgram,
    ESLintForInStatement,
    ESLintForOfStatement,
    ESLintFunctionExpression,
    ESLintPattern,
    ESLintProgram,
    ESLintVariableDeclaration,
    ESLintUnaryExpression,
    Node,
    ParseError,
    Reference,
    Token,
    Variable,
    VElement,
    VForExpression,
    VOnExpression,
    VSlotScopeExpression,
} from "../ast"
import { debug } from "../common/debug"
import { LocationCalculator } from "../common/location-calculator"
import {
    analyzeExternalReferences,
    analyzeVariablesAndExternalReferences,
} from "./scope-analyzer"

// [1] = spacing before the aliases.
// [2] = aliases.
// [3] = all after the aliases.
const ALIAS_PARENS = /^(\s*)\(([\s\S]+)\)(\s*(?:in|of)\b[\s\S]+)$/
const DUMMY_PARENT: any = {}

/**
 * The interface of ESLint custom parsers.
 */
interface ESLintCustomParser {
    parse(code: string, options: any): ESLintCustomParserResult
    parseForESLint?(code: string, options: any): ESLintCustomParserResult
}

/**
 * Do post-process of parsing an expression.
 *
 * 1. Set `node.parent`.
 * 2. Fix `node.range` and `node.loc` for HTML entities.
 *
 * @param result The parsing result to modify.
 * @param locationCalculator The location calculator to modify.
 */
function postprocess(
    result: ESLintExtendedProgram,
    locationCalculator: LocationCalculator,
): void {
    // There are cases which the same node instance appears twice in the tree.
    // E.g. `let {a} = {}` // This `a` appears twice at `Property#key` and `Property#value`.
    const traversed = new Set<Node | number[]>()

    traverseNodes(result.ast, {
        visitorKeys: result.visitorKeys,

        enterNode(node, parent) {
            if (!traversed.has(node)) {
                traversed.add(node)
                node.parent = parent

                // `babel-eslint@8` has shared `Node#range` with multiple nodes.
                // See also: https://github.com/vuejs/eslint-plugin-vue/issues/208
                if (!traversed.has(node.range)) {
                    traversed.add(node.range)
                    locationCalculator.fixLocation(node)
                }

                if (
                    node.type === "Identifier" &&
                    node.typeAnnotation &&
                    !traversed.has(node.typeAnnotation)
                ) {
                    traversed.add(node.typeAnnotation)
                    locationCalculator.fixLocation(node.typeAnnotation)
                }
            }
        },

        leaveNode() {
            // Do nothing.
        },
    })

    for (const token of result.ast.tokens || []) {
        locationCalculator.fixLocation(token)
    }
    for (const comment of result.ast.comments || []) {
        locationCalculator.fixLocation(comment)
    }
}

/**
 * Replace parentheses which wrap the alias of 'v-for' directive values by array brackets in order to avoid syntax errors.
 * @param code The code to replace.
 * @returns The replaced code.
 */
function replaceAliasParens(code: string): string {
    const match = ALIAS_PARENS.exec(code)
    if (match != null) {
        return `${match[1]}[${match[2]}]${match[3]}`
    }
    return code
}

/**
 * Normalize the `ForXStatement#left` node to parse v-for expressions.
 * @param left The `ForXStatement#left` node to normalize.
 * @param replaced The flag to indicate that the alias parentheses were replaced.
 */
function normalizeLeft(
    left: ESLintVariableDeclaration | ESLintPattern,
    replaced: boolean,
): ESLintPattern[] {
    if (left.type !== "VariableDeclaration") {
        throw new Error("unreachable")
    }
    const id = left.declarations[0].id

    if (replaced) {
        return (id as ESLintArrayPattern).elements
    }
    return [id]
}

/**
 * Get the comma token before a given node.
 * @param tokens The token list.
 * @param node The node to get the comma before this node.
 * @returns The comma token.
 */
function getCommaTokenBeforeNode(tokens: Token[], node: Node): Token | null {
    let tokenIndex = sortedIndexBy(
        tokens,
        { range: node.range },
        t => t.range[0],
    )

    while (tokenIndex >= 0) {
        const token = tokens[tokenIndex]
        if (token.type === "Punctuator" && token.value === ",") {
            return token
        }
        tokenIndex -= 1
    }

    return null
}

/**
 * Throw syntax error for empty.
 * @param locationCalculator The location calculator to get line/column.
 */
function throwEmptyError(
    locationCalculator: LocationCalculator,
    expected: string,
): never {
    const loc = locationCalculator.getLocation(0)
    const err = new ParseError(
        `Expected to be ${expected}, but got empty.`,
        undefined,
        0,
        loc.line,
        loc.column,
    )
    locationCalculator.fixErrorLocation(err)

    throw err
}

/**
 * Throw syntax error for unexpected token.
 * @param locationCalculator The location calculator to get line/column.
 * @param name The token name.
 * @param token The token object to get that location.
 */
function throwUnexpectedTokenError(name: string, token: Node | Token): never {
    const err = new ParseError(
        `Unexpected token '${name}'.`,
        undefined,
        token.range[0],
        token.loc.start.line,
        token.loc.start.column,
    )

    throw err
}

/**
 * Throw syntax error of outside of code.
 * @param locationCalculator The location calculator to get line/column.
 */
function throwErrorAsAdjustingOutsideOfCode(
    err: any,
    code: string,
    locationCalculator: LocationCalculator,
): never {
    if (ParseError.isParseError(err)) {
        const endOffset = locationCalculator.getOffsetWithGap(code.length)
        if (err.index >= endOffset) {
            err.message = "Unexpected end of expression."
        }
    }

    throw err
}

/**
 * Parse the given source code.
 *
 * @param code The source code to parse.
 * @param locationCalculator The location calculator for postprocess.
 * @param parserOptions The parser options.
 * @returns The result of parsing.
 */
function parseScriptFragment(
    code: string,
    locationCalculator: LocationCalculator,
    parserOptions: any,
): ESLintExtendedProgram {
    try {
        const result = parseScript(code, parserOptions)
        postprocess(result, locationCalculator)
        return result
    } catch (err) {
        const perr = ParseError.normalize(err)
        if (perr) {
            locationCalculator.fixErrorLocation(perr)
            throw perr
        }
        throw err
    }
}

/**
 * The result of parsing expressions.
 */
export interface ExpressionParseResult {
    expression:
        | ESLintExpression
        | VForExpression
        | VOnExpression
        | VSlotScopeExpression
        | null
    tokens: Token[]
    comments: Token[]
    references: Reference[]
    variables: Variable[]
}

/**
 * The interface of a result of ESLint custom parser.
 */
export type ESLintCustomParserResult = ESLintProgram | ESLintExtendedProgram

/**
 * Parse the given source code.
 *
 * @param code The source code to parse.
 * @param parserOptions The parser options.
 * @returns The result of parsing.
 */
export function parseScript(
    code: string,
    parserOptions: any,
): ESLintExtendedProgram {
    const parser: ESLintCustomParser =
        typeof parserOptions.parser === "string"
            ? require(parserOptions.parser)
            : require("espree")
    const result: any =
        typeof parser.parseForESLint === "function"
            ? parser.parseForESLint(code, parserOptions)
            : parser.parse(code, parserOptions)

    if (result.ast != null) {
        return result
    }
    return { ast: result }
}

/**
 * Parse the source code of the given `<script>` element.
 * @param node The `<script>` element to parse.
 * @param globalLocationCalculator The location calculator for postprocess.
 * @param parserOptions The parser options.
 * @returns The result of parsing.
 */
export function parseScriptElement(
    node: VElement,
    globalLocationCalculator: LocationCalculator,
    parserOptions: any,
): ESLintExtendedProgram {
    const text = node.children[0]
    const offset =
        text != null && text.type === "VText"
            ? text.range[0]
            : node.startTag.range[1]
    const code = text != null && text.type === "VText" ? text.value : ""
    const locationCalculator = globalLocationCalculator.getSubCalculatorAfter(
        offset,
    )
    const result = parseScriptFragment(code, locationCalculator, parserOptions)

    // Needs the tokens of start/end tags for `lines-around-*` rules to work
    // correctly.
    if (result.ast.tokens != null) {
        const startTag = node.startTag
        const endTag = node.endTag

        if (startTag != null) {
            result.ast.tokens.unshift({
                type: "Punctuator",
                range: startTag.range,
                loc: startTag.loc,
                value: "<script>",
            })
        }
        if (endTag != null) {
            result.ast.tokens.push({
                type: "Punctuator",
                range: endTag.range,
                loc: endTag.loc,
                value: "</script>",
            })
        }
    }

    return result
}

/**
 * Parse the source code of inline scripts.
 * @param code The source code of inline scripts.
 * @param locationCalculator The location calculator for the inline script.
 * @param parserOptions The parser options.
 * @returns The result of parsing.
 */
export function parseExpression(
    code: string,
    locationCalculator: LocationCalculator,
    parserOptions: any,
    allowEmpty = false,
): ExpressionParseResult {
    debug('[script] parse expression: "0(%s)"', code)

    try {
        const ast = parseScriptFragment(
            `0(${code})`,
            locationCalculator.getSubCalculatorAfter(-2),
            parserOptions,
        ).ast
        const tokens = ast.tokens || []
        const comments = ast.comments || []
        const references = analyzeExternalReferences(ast, parserOptions)
        const statement = ast.body[0] as ESLintExpressionStatement
        const callExpression = statement.expression as ESLintCallExpression
        const expression = callExpression.arguments[0]

        if (!allowEmpty && !expression) {
            return throwEmptyError(locationCalculator, "an expression")
        }
        if (expression && expression.type === "SpreadElement") {
            return throwUnexpectedTokenError("...", expression)
        }
        if (callExpression.arguments[1]) {
            const node = callExpression.arguments[1]
            return throwUnexpectedTokenError(
                ",",
                getCommaTokenBeforeNode(tokens, node) || node,
            )
        }

        // Remove parens.
        tokens.shift()
        tokens.shift()
        tokens.pop()

        return { expression, tokens, comments, references, variables: [] }
    } catch (err) {
        return throwErrorAsAdjustingOutsideOfCode(err, code, locationCalculator)
    }
}

/**
 * Parse the source code of inline scripts.
 * @param code The source code of inline scripts.
 * @param locationCalculator The location calculator for the inline script.
 * @param parserOptions The parser options.
 * @returns The result of parsing.
 */
export function parseVForExpression(
    code: string,
    locationCalculator: LocationCalculator,
    parserOptions: any,
): ExpressionParseResult {
    const processedCode = replaceAliasParens(code)
    debug('[script] parse v-for expression: "for(%s);"', processedCode)

    if (code.trim() === "") {
        throwEmptyError(locationCalculator, "'<alias> in <expression>'")
    }

    try {
        const replaced = processedCode !== code
        const ast = parseScriptFragment(
            `for(let ${processedCode});`,
            locationCalculator.getSubCalculatorAfter(-8),
            parserOptions,
        ).ast
        const tokens = ast.tokens || []
        const comments = ast.comments || []
        const scope = analyzeVariablesAndExternalReferences(ast, parserOptions)
        const references = scope.references
        const variables = scope.variables
        const statement = ast.body[0] as
            | ESLintForInStatement
            | ESLintForOfStatement
        const left = normalizeLeft(statement.left, replaced)
        const right = statement.right
        const firstToken = tokens[3] || statement.left
        const lastToken = tokens[tokens.length - 3] || statement.right
        const expression: VForExpression = {
            type: "VForExpression",
            range: [firstToken.range[0], lastToken.range[1]],
            loc: { start: firstToken.loc.start, end: lastToken.loc.end },
            parent: DUMMY_PARENT,
            left,
            right,
        }

        // Modify parent.
        for (const l of left) {
            if (l != null) {
                l.parent = expression
            }
        }
        right.parent = expression

        // Remvoe `for` `(` `let` `)` `;`.
        tokens.shift()
        tokens.shift()
        tokens.shift()
        tokens.pop()
        tokens.pop()

        // Restore parentheses from array brackets.
        if (replaced) {
            const closeOffset = statement.left.range[1] - 1
            const open = tokens[0]
            const close = tokens.find(t => t.range[0] === closeOffset)

            if (open != null) {
                open.value = "("
            }
            if (close != null) {
                close.value = ")"
            }
        }

        return { expression, tokens, comments, references, variables }
    } catch (err) {
        return throwErrorAsAdjustingOutsideOfCode(err, code, locationCalculator)
    }
}

/**
 * Parse the source code of inline scripts.
 * @param code The source code of inline scripts.
 * @param locationCalculator The location calculator for the inline script.
 * @param parserOptions The parser options.
 * @returns The result of parsing.
 */
export function parseVOnExpression(
    code: string,
    locationCalculator: LocationCalculator,
    parserOptions: any,
): ExpressionParseResult {
    debug('[script] parse v-on expression: "void function($event){%s}"', code)

    if (code.trim() === "") {
        throwEmptyError(locationCalculator, "statements")
    }

    try {
        const ast = parseScriptFragment(
            `void function($event){${code}}`,
            locationCalculator.getSubCalculatorAfter(-22),
            parserOptions,
        ).ast
        const references = analyzeExternalReferences(ast, parserOptions)
        const outermostStatement = ast.body[0] as ESLintExpressionStatement
        const functionDecl = (outermostStatement.expression as ESLintUnaryExpression)
            .argument as ESLintFunctionExpression
        const block = functionDecl.body
        const body = block.body
        const firstStatement = first(body)
        const lastStatement = last(body)
        const expression: VOnExpression = {
            type: "VOnExpression",
            range: [
                firstStatement != null
                    ? firstStatement.range[0]
                    : block.range[0] + 1,
                lastStatement != null
                    ? lastStatement.range[1]
                    : block.range[1] - 1,
            ],
            loc: {
                start:
                    firstStatement != null
                        ? firstStatement.loc.start
                        : locationCalculator.getLocation(1),
                end:
                    lastStatement != null
                        ? lastStatement.loc.end
                        : locationCalculator.getLocation(code.length + 1),
            },
            parent: DUMMY_PARENT,
            body,
        }
        const tokens = ast.tokens || []
        const comments = ast.comments || []

        // Modify parent.
        for (const b of body) {
            b.parent = expression
        }

        // Remove braces.
        tokens.splice(0, 6)
        tokens.pop()

        return { expression, tokens, comments, references, variables: [] }
    } catch (err) {
        return throwErrorAsAdjustingOutsideOfCode(err, code, locationCalculator)
    }
}

/**
 * Parse the source code of `slot-scope` directive.
 * @param code The source code of `slot-scope` directive.
 * @param locationCalculator The location calculator for the inline script.
 * @param parserOptions The parser options.
 * @returns The result of parsing.
 */
export function parseSlotScopeExpression(
    code: string,
    locationCalculator: LocationCalculator,
    parserOptions: any,
): ExpressionParseResult {
    debug('[script] parse slot-scope expression: "void function(%s) {}"', code)

    if (code.trim() === "") {
        throwEmptyError(
            locationCalculator,
            "an identifier or an array/object pattern",
        )
    }

    try {
        const ast = parseScriptFragment(
            `void function(${code}) {}`,
            locationCalculator.getSubCalculatorAfter(-14),
            parserOptions,
        ).ast
        const tokens = ast.tokens || []
        const comments = ast.comments || []
        const scope = analyzeVariablesAndExternalReferences(ast, parserOptions)
        const references = scope.references
        const variables = scope.variables
        const statement = ast.body[0] as ESLintExpressionStatement
        const rawExpression = statement.expression as ESLintUnaryExpression
        const functionDecl = rawExpression.argument as ESLintFunctionExpression
        const id = functionDecl.params[0]
        const expression: VSlotScopeExpression = {
            type: "VSlotScopeExpression",
            range: [id.range[0], id.range[1]],
            loc: { start: id.loc.start, end: id.loc.end },
            parent: DUMMY_PARENT,
            id,
        }

        // Modify parent.
        id.parent = expression

        // Remvoe `void` `function` `(` `)` `{` `}`.
        tokens.shift()
        tokens.shift()
        tokens.shift()
        tokens.pop()
        tokens.pop()
        tokens.pop()

        return { expression, tokens, comments, references, variables }
    } catch (err) {
        return throwErrorAsAdjustingOutsideOfCode(err, code, locationCalculator)
    }
}
