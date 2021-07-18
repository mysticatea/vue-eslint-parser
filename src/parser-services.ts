/**
 * @author Toru Nagashima <https://github.com/mysticatea>
 * @copyright 2017 Toru Nagashima. All rights reserved.
 * See LICENSE file in root directory for full license.
 */
import type { Rule } from "eslint"
import EventEmitter from "events"
import NodeEventGenerator from "./external/node-event-generator"
import TokenStore from "./external/token-store"
import type {
    ESLintProgram,
    VElement,
    VDocumentFragment,
    VAttribute,
} from "./ast"
import { getFallbackKeys, KEYS, traverseNodes } from "./ast/traverse"
import type { LocationCalculatorForHtml } from "./common/location-calculator"
import type {
    CustomBlockContext,
    ESLintCustomBlockParser,
} from "./sfc/custom-block"
import {
    createCustomBlockSharedContext,
    getCustomBlocks,
    parseCustomBlockElement,
} from "./sfc/custom-block"
import type { ParserOptions } from "./common/parser-options"
import { isSFCFile } from "./common/parser-options"
import { getLang } from "./common/ast-utils"

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

type CustomBlockVisitorFactory = (context: CustomBlockContext) =>
    | {
          [key: string]: (...args: any) => void
      }
    | null
    | undefined

//------------------------------------------------------------------------------
// Exports
//------------------------------------------------------------------------------

export interface ParserServices {
    /**
     * Define handlers to traverse the template body.
     * @param templateBodyVisitor The template body handlers.
     * @param scriptVisitor The script handlers. This is optional.
     * @param options The options. This is optional.
     */
    defineTemplateBodyVisitor(
        templateBodyVisitor: { [key: string]: (...args: any) => void },
        scriptVisitor?: { [key: string]: (...args: any) => void },
        options?: { templateBodyTriggerSelector: "Program" | "Program:exit" },
    ): object

    /**
     * Define handlers to traverse the document.
     * @param documentVisitor The document handlers.
     * @param options The options. This is optional.
     */
    defineDocumentVisitor(
        documentVisitor: { [key: string]: (...args: any) => void },
        options?: { triggerSelector: "Program" | "Program:exit" },
    ): object

    /**
     * Define handlers to traverse custom blocks.
     * @param context The rule context.
     * @param parser The custom parser.
     * @param rule The custom block rule definition
     * @param scriptVisitor The script handlers. This is optional.
     */
    defineCustomBlocksVisitor(
        context: Rule.RuleContext,
        parser: ESLintCustomBlockParser,
        rule: {
            target:
                | string
                | string[]
                | ((lang: string | null, customBlock: VElement) => boolean)
            create: CustomBlockVisitorFactory
        },
        scriptVisitor: { [key: string]: (...args: any) => void },
    ): { [key: string]: (...args: any) => void }

    /**
     * Get the token store of the template body.
     * @returns The token store of template body.
     */
    getTemplateBodyTokenStore(): TokenStore

    /**
     * Get the root document fragment.
     * @returns The root document fragment.
     */
    getDocumentFragment(): VDocumentFragment | null
}

/**
 * Define the parser service
 * @param rootAST
 */
export function define(
    sourceText: string,
    rootAST: ESLintProgram,
    document: VDocumentFragment | null,
    globalLocationCalculator: LocationCalculatorForHtml | null,
    { parserOptions }: { parserOptions: ParserOptions },
): ParserServices {
    const templateBodyEmitters = new Map<string, EventEmitter>()
    const stores = new WeakMap<object, TokenStore>()

    const documentEmitters = new Map<string, EventEmitter>()

    const customBlocksEmitters = new Map<
        | ESLintCustomBlockParser["parseForESLint"]
        | ESLintCustomBlockParser["parse"],
        {
            context: Rule.RuleContext
            test: (lang: string | null, customBlock: VElement) => boolean
            create: CustomBlockVisitorFactory
        }[]
    >()

    const isSFC = isSFCFile(parserOptions)

    return {
        /**
         * Define handlers to traverse the template body.
         * @param templateBodyVisitor The template body handlers.
         * @param scriptVisitor The script handlers. This is optional.
         */
        defineTemplateBodyVisitor(
            templateBodyVisitor: { [key: string]: (...args: any) => void },
            scriptVisitor?: { [key: string]: (...args: any) => void },
            options?: {
                templateBodyTriggerSelector: "Program" | "Program:exit"
            },
        ): object {
            if (scriptVisitor == null) {
                scriptVisitor = {} //eslint-disable-line no-param-reassign
            }
            if (rootAST.templateBody == null) {
                return scriptVisitor
            }
            const templateBodyTriggerSelector =
                options?.templateBodyTriggerSelector ?? "Program:exit"

            let emitter = templateBodyEmitters.get(templateBodyTriggerSelector)

            // If this is the first time, initialize the intermediate event emitter.
            if (emitter == null) {
                emitter = new EventEmitter()
                emitter.setMaxListeners(0)
                templateBodyEmitters.set(templateBodyTriggerSelector, emitter)

                const programExitHandler =
                    scriptVisitor[templateBodyTriggerSelector]
                scriptVisitor[templateBodyTriggerSelector] = (node) => {
                    try {
                        if (typeof programExitHandler === "function") {
                            programExitHandler(node)
                        }

                        // Traverse template body.
                        const generator = new NodeEventGenerator(emitter!, {
                            visitorKeys: KEYS,
                            fallback: getFallbackKeys,
                        })
                        traverseNodes(
                            rootAST.templateBody as VElement,
                            generator,
                        )
                    } finally {
                        // eslint-disable-next-line @mysticatea/ts/ban-ts-ignore
                        // @ts-ignore
                        scriptVisitor[templateBodyTriggerSelector] =
                            programExitHandler
                        templateBodyEmitters.delete(templateBodyTriggerSelector)
                    }
                }
            }

            // Register handlers into the intermediate event emitter.
            for (const selector of Object.keys(templateBodyVisitor)) {
                emitter.on(selector, templateBodyVisitor[selector])
            }

            return scriptVisitor
        },

        /**
         * Define handlers to traverse the document.
         * @param documentVisitor The document handlers.
         * @param options The options. This is optional.
         */
        defineDocumentVisitor(
            documentVisitor: { [key: string]: (...args: any) => void },
            options?: { triggerSelector: "Program" | "Program:exit" },
        ): object {
            const scriptVisitor: { [key: string]: (...args: any) => void } = {}
            if (!document) {
                return scriptVisitor
            }

            const documentTriggerSelector =
                options?.triggerSelector ?? "Program:exit"

            let emitter = documentEmitters.get(documentTriggerSelector)

            // If this is the first time, initialize the intermediate event emitter.
            if (emitter == null) {
                emitter = new EventEmitter()
                emitter.setMaxListeners(0)
                documentEmitters.set(documentTriggerSelector, emitter)

                const programExitHandler =
                    scriptVisitor[documentTriggerSelector]
                scriptVisitor[documentTriggerSelector] = (node) => {
                    try {
                        if (typeof programExitHandler === "function") {
                            programExitHandler(node)
                        }

                        // Traverse document.
                        const generator = new NodeEventGenerator(emitter!, {
                            visitorKeys: KEYS,
                            fallback: getFallbackKeys,
                        })
                        traverseNodes(document, generator)
                    } finally {
                        // eslint-disable-next-line @mysticatea/ts/ban-ts-ignore
                        // @ts-ignore
                        scriptVisitor[documentTriggerSelector] =
                            programExitHandler
                        documentEmitters.delete(documentTriggerSelector)
                    }
                }
            }

            // Register handlers into the intermediate event emitter.
            for (const selector of Object.keys(documentVisitor)) {
                emitter.on(selector, documentVisitor[selector])
            }

            return scriptVisitor
        },

        /**
         * Define handlers to traverse custom blocks.
         * @param context The rule context.
         * @param parser The custom parser.
         * @param rule The custom block rule definition
         * @param scriptVisitor The script handlers. This is optional.
         */
        defineCustomBlocksVisitor(
            context: Rule.RuleContext,
            parser: ESLintCustomBlockParser,
            rule: {
                target:
                    | string
                    | string[]
                    | ((lang: string | null, customBlock: VElement) => boolean)
                create: CustomBlockVisitorFactory
            },
            scriptVisitor: { [key: string]: (...args: any) => void },
        ): { [key: string]: (...args: any) => void } {
            if (scriptVisitor == null) {
                scriptVisitor = {} //eslint-disable-line no-param-reassign
            }
            if (!isSFC) {
                return scriptVisitor
            }
            parserOptions = { ...parserOptions } //eslint-disable-line no-param-reassign
            const customBlocks = getCustomBlocks(document).filter(
                (block) =>
                    block.endTag &&
                    !block.startTag.attributes.some(
                        (attr): attr is VAttribute =>
                            !attr.directive && attr.key.name === "src",
                    ),
            )
            if (!customBlocks.length || globalLocationCalculator == null) {
                return {}
            }
            const key = parser.parseForESLint ?? parser.parse
            let factories = customBlocksEmitters.get(key)

            // If this is the first time, initialize the intermediate event emitter.
            if (factories == null) {
                factories = []
                customBlocksEmitters.set(key, factories)
                const visitorFactories = factories

                const programExitHandler = scriptVisitor["Program:exit"]
                scriptVisitor["Program:exit"] = (node) => {
                    try {
                        if (typeof programExitHandler === "function") {
                            programExitHandler(node)
                        }
                        for (const customBlock of customBlocks) {
                            const lang = getLang(customBlock)

                            const activeVisitorFactories =
                                visitorFactories.filter((f) =>
                                    f.test(lang, customBlock),
                                )
                            if (!activeVisitorFactories.length) {
                                continue
                            }

                            const parsedResult = parseCustomBlockElement(
                                customBlock,
                                parser,
                                globalLocationCalculator,
                                parserOptions,
                            )

                            const {
                                serCurrentNode,
                                context: customBlockContext,
                            } = createCustomBlockSharedContext({
                                text: sourceText,
                                customBlock,
                                parsedResult,
                                globalLocationCalculator,
                                parserOptions,
                            })

                            const emitter = new EventEmitter()
                            emitter.setMaxListeners(0)

                            for (const factory of activeVisitorFactories) {
                                const ctx = {
                                    ...customBlockContext,
                                }
                                // eslint-disable-next-line @mysticatea/ts/ban-ts-ignore
                                // @ts-ignore -- custom context
                                ctx.__proto__ = factory.context

                                const visitor = factory.create(
                                    ctx as CustomBlockContext,
                                )
                                // Register handlers into the intermediate event emitter.
                                for (const selector of Object.keys(
                                    visitor || {},
                                )) {
                                    emitter.on(selector, visitor![selector])
                                }
                            }

                            // Traverse custom block.
                            const generator = new NodeEventGenerator(emitter, {
                                visitorKeys: parsedResult.visitorKeys,
                                fallback: getFallbackKeys,
                            })
                            traverseNodes(parsedResult.ast, {
                                visitorKeys: parsedResult.visitorKeys,
                                enterNode(n) {
                                    serCurrentNode(n)
                                    generator.enterNode(n)
                                },
                                leaveNode(n) {
                                    serCurrentNode(n)
                                    generator.leaveNode(n)
                                },
                            })
                        }
                    } finally {
                        // eslint-disable-next-line @mysticatea/ts/ban-ts-ignore
                        // @ts-ignore
                        scriptVisitor["Program:exit"] = programExitHandler
                        customBlocksEmitters.delete(key)
                    }
                }
            }

            const target = rule.target
            const test =
                typeof target === "function"
                    ? target
                    : Array.isArray(target)
                    ? (lang: string | null) =>
                          Boolean(lang && target.includes(lang))
                    : (lang: string | null) => target === lang
            factories.push({
                context,
                test,
                create: rule.create,
            })

            return scriptVisitor
        },

        /**
         * Get the token store of the template body.
         * @returns The token store of template body.
         */
        getTemplateBodyTokenStore(): TokenStore {
            const key = document || stores
            let store = stores.get(key)

            if (!store) {
                store =
                    document != null
                        ? new TokenStore(document.tokens, document.comments)
                        : new TokenStore([], [])
                stores.set(key, store)
            }

            return store
        },

        /**
         * Get the root document fragment.
         * @returns The root document fragment.
         */
        getDocumentFragment(): VDocumentFragment | null {
            return document
        },
    }
}
