/**
 * MCP Server Factory — creates a Model Context Protocol server
 * wired to a DiscordProvider.
 *
 * This is provider-agnostic: pass any DiscordProvider implementation
 * and you get a fully functional MCP server with all Discord tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { allTools, type ToolDefinition } from './tools/registry.js';
import { confirmSchema, policyFromEnv, selectTools, type ToolPolicy } from './tools/policy.js';
import type { DiscordProvider } from './providers/discord-provider.js';
import { z } from 'zod';

export interface CreateServerOptions {
    provider: DiscordProvider;
    /** Server name shown to MCP clients */
    name?: string;
    /** Server version */
    version?: string;
    /**
     * Additional tools to register on top of the built-in set. Host applications
     * can use this to expose host-specific capabilities (database-backed features,
     * bot-owned state, etc.) through the same MCP surface.
     */
    extraTools?: ToolDefinition[];
    /** Which tools to expose. Defaults to MCP_DISCORD_ALLOW / MCP_DISCORD_DENY. */
    policy?: ToolPolicy;
}

/**
 * Recursively unwraps Zod schemas to extract the shape.
 * Handles ZodObject, ZodEffects (refine/transform), ZodOptional, ZodDefault, etc.
 */
function extractZodShape(schema: z.ZodType<any>): Record<string, any> {
    let current: any = schema;
    while (current) {
        // Check if this is a ZodObject with a shape
        if (current._def?.shape) return current._def.shape();
        // Unwrap ZodEffects (refine, transform, etc.)
        if (current._def?.schema) {
            current = current._def.schema;
            continue;
        }
        // Unwrap ZodOptional
        if (current._def?.innerType) {
            current = current._def.innerType;
            continue;
        }
        // Direct shape property (fallback)
        if (current.shape) return current.shape;
        break;
    }
    return {};
}

export function createMcpServer(options: CreateServerOptions): McpServer {
    const { provider, name = 'discord-mcp-server', version = '0.1.0', extraTools = [], policy = policyFromEnv() } = options;

    const server = new McpServer({
        name,
        version,
    });

    const combinedTools: ToolDefinition[] = selectTools([...allTools, ...extraTools], policy);

    // Register every tool the policy exposes, from the registry and host-provided extensions
    for (const tool of combinedTools) {
        const gated = tool.requiresConfirmation === true;
        const shape = extractZodShape(tool.schema);

        server.tool(
            tool.name,
            tool.description,
            gated ? { ...shape, confirm: confirmSchema(tool.name) } : shape,
            { destructiveHint: tool.isDestructive === true },
            async (rawInput: any) => {
                const { confirm: _confirm, ...strippedInput } = rawInput;
                const input = gated ? strippedInput : rawInput;

                try {
                    if (!provider.isReady()) {
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Discord provider is not connected. Call connect() first.' }) }],
                            isError: true,
                        };
                    }

                    const result = await tool.handler(input, provider);

                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                    };
                } catch (err: any) {
                    const error: Record<string, any> = {
                        message: err?.message ?? String(err),
                        code: err?.code ?? 'UNKNOWN',
                    };

                    // Discord API error details
                    if (err?.status) error.status = err.status;
                    if (err?.method) error.method = err.method;
                    if (err?.url) error.url = err.url;
                    if (err?.rawError?.errors) error.validationErrors = err.rawError.errors;
                    if (err?.retry_after) {
                        error.retryAfter = err.retry_after;
                        error.message += ` (retry after ${err.retry_after}s)`;
                    }

                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify(error, null, 2) }],
                        isError: true,
                    };
                }
            }
        );
    }

    return server;
}
