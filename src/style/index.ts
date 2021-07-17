import type {
    OffsetRange,
    Token,
    VElement,
    VExpressionContainer,
    VStyleElement,
    VText,
} from "../ast"
import { ParseError } from "../ast"
import { getLang, getOwnerDocument } from "../common/ast-utils"
import { debug } from "../common/debug"
import { insertError } from "../common/error-utils"
import type { LocationCalculatorForHtml } from "../common/location-calculator"
import type { ParserOptions } from "../common/parser-options"
import {
    createSimpleToken,
    insertComments,
    replaceAndSplitTokens,
} from "../common/token-utils"
import { parseExpression } from "../script"
import { DEFAULT_ECMA_VERSION } from "../script-setup/parser-options"
import { resolveReferences } from "../template"

/**
 * Parse the source code of the given `<style>` elements.
 * @param elements The `<style>` elements to parse.
 * @param globalLocationCalculator The location calculator for fixLocations.
 * @param parserOptions The parser options.
 * @returns The result of parsing.
 */
export function parseStyleElements(
    elements: VElement[],
    globalLocationCalculator: LocationCalculatorForHtml,
    originalParserOptions: ParserOptions,
): void {
    const parserOptions: ParserOptions = {
        ...originalParserOptions,
        ecmaVersion: originalParserOptions.ecmaVersion || DEFAULT_ECMA_VERSION,
    }

    for (const style of elements) {
        ;(style as VStyleElement).style = true
        parseStyle(
            style as VStyleElement,
            globalLocationCalculator,
            parserOptions,
            {
                inlineComment: (getLang(style) || "css") !== "css",
            },
        )
    }
}

function parseStyle(
    style: VStyleElement,
    locationCalculator: LocationCalculatorForHtml,
    parserOptions: ParserOptions,
    cssOptions: { inlineComment?: boolean },
) {
    if (style.children.length !== 1) {
        return
    }
    const textNode = style.children[0]
    if (textNode.type !== "VText") {
        return
    }
    const text = textNode.value
    if (!text.includes("v-bind(")) {
        return
    }

    const document = getOwnerDocument(style)

    let textStart = 0
    for (const { range, expr, exprOffset, quote } of iterateVBind(
        textNode.range[0],
        text,
        cssOptions,
    )) {
        const container: VExpressionContainer = {
            type: "VExpressionContainer",
            range: [
                locationCalculator.getOffsetWithGap(range[0]),
                locationCalculator.getOffsetWithGap(range[1]),
            ],
            loc: {
                start: locationCalculator.getLocation(range[0]),
                end: locationCalculator.getLocation(range[1]),
            },
            parent: style,
            expression: null,
            references: [],
        }

        const beforeTokens: Token[] = [
            createSimpleToken(
                "HTMLText",
                container.range[0],
                container.range[0] + 6 /* v-bind */,
                "v-bind",
                locationCalculator,
            ),
            createSimpleToken(
                "Punctuator",
                container.range[0] + 6 /* v-bind */,
                container.range[0] + 7,
                "(",
                locationCalculator,
            ),
        ]
        const afterTokens: Token[] = [
            createSimpleToken(
                "Punctuator",
                container.range[1] - 1,
                container.range[1],
                ")",
                locationCalculator,
            ),
        ]
        if (quote) {
            const openStart = locationCalculator.getOffsetWithGap(
                exprOffset - 1,
            )
            beforeTokens.push(
                createSimpleToken(
                    "Punctuator",
                    openStart,
                    openStart + 1,
                    quote,
                    locationCalculator,
                ),
            )
            const closeStart = locationCalculator.getOffsetWithGap(
                exprOffset + expr.length,
            )
            afterTokens.unshift(
                createSimpleToken(
                    "Punctuator",
                    closeStart,
                    closeStart + 1,
                    quote,
                    locationCalculator,
                ),
            )
        }

        const lastChild = style.children[style.children.length - 1]
        style.children.push(container)
        if (lastChild.type === "VText") {
            const newTextNode: VText = {
                type: "VText",
                range: [container.range[1], lastChild.range[1]],
                loc: {
                    start: { ...container.loc.end },
                    end: { ...lastChild.loc.end },
                },
                parent: style,
                value: text.slice(range[1] - textNode.range[0]),
            }
            style.children.push(newTextNode)

            lastChild.range[1] = container.range[0]
            lastChild.loc.end = { ...container.loc.start }
            lastChild.value = text.slice(
                textStart,
                range[0] - textNode.range[0],
            )
            textStart = range[1] - textNode.range[0]
        }
        try {
            const ret = parseExpression(
                expr,
                locationCalculator.getSubCalculatorShift(exprOffset),
                parserOptions,
                { allowEmpty: false, allowFilters: false },
            )
            if (ret.expression) {
                ret.expression.parent = container
                container.expression = ret.expression
                container.references = ret.references
            }
            replaceAndSplitTokens(document, container, [
                ...beforeTokens,
                ...ret.tokens,
                ...afterTokens,
            ])
            insertComments(document, ret.comments)

            for (const variable of ret.variables) {
                style.variables.push(variable)
            }
            resolveReferences(container)
        } catch (err) {
            replaceAndSplitTokens(document, container, [
                ...beforeTokens,
                createSimpleToken(
                    "HTMLText",
                    beforeTokens[beforeTokens.length - 1].range[1],
                    afterTokens[0].range[0],
                    expr,
                    locationCalculator,
                ),
                ...afterTokens,
            ])
            debug("[style] Parse error: %s", err)

            if (ParseError.isParseError(err)) {
                insertError(document, err)
            } else {
                throw err
            }
        }
    }
}

type VBindLocations = {
    range: OffsetRange
    expr: string
    exprOffset: number
    quote: '"' | "'" | null
}

/**
 * Iterate the `v-bind()` information.
 */
function* iterateVBind(
    offset: number,
    text: string,
    cssOptions: { inlineComment?: boolean },
): IterableIterator<VBindLocations> {
    const re = cssOptions.inlineComment
        ? /"|'|\/\*|\/\/|\bv-bind\(\s*(?:'([^']+)'|"([^"]+)"|([^'"][^)]*))\s*\)/gu
        : /"|'|\/\*|\bv-bind\(\s*(?:'([^']+)'|"([^"]+)"|([^'"][^)]*))\s*\)/gu
    let match
    while ((match = re.exec(text))) {
        const startOrVBind = match[0]
        if (startOrVBind === '"' || startOrVBind === "'") {
            // skip string
            re.lastIndex = skipString(startOrVBind, re.lastIndex)
        } else if (startOrVBind === "/*" || startOrVBind === "//") {
            // skip comment
            re.lastIndex = skipComment(
                startOrVBind === "/*" ? "block" : "line",
                re.lastIndex,
            )
        } else {
            // v-bind
            const vBind = startOrVBind
            const quote = match[1] ? "'" : match[2] ? '"' : null
            const expr = match[1] || match[2] || match[3]
            const start = match.index + offset
            const end = re.lastIndex + offset
            const exprOffset =
                start +
                vBind.indexOf(quote || match[3], 7 /* v-bind( */) +
                (quote ? 1 /* quote */ : 0)
            yield {
                range: [start, end],
                expr,
                exprOffset,
                quote,
            }
        }
    }

    function skipString(quote: string, nextIndex: number): number {
        for (let index = nextIndex; index < text.length; index++) {
            const c = text[index]
            if (c === "\\") {
                index++ // escaping
                continue
            }
            if (c === quote) {
                return index + 1
            }
        }
        return nextIndex
    }

    function skipComment(kind: "block" | "line", nextIndex: number): number {
        const index = text.indexOf(kind === "block" ? "*/" : "\n", nextIndex)
        return Math.max(index, nextIndex)
    }
}
