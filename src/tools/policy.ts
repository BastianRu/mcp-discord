/**
 * Tool policy — decides which tools are exposed and how destructive tools are gated.
 *
 *   MCP_DISCORD_ALLOW  comma-separated allowlist (empty/unset = every tool)
 *   MCP_DISCORD_DENY   comma-separated denylist; always wins over the allowlist
 *
 * Entries are tool names (`delete_channel`) or categories (`category:moderation`).
 * Unknown entries abort startup: a typo in a denylist must not silently expose a tool.
 */

import { z } from 'zod';
import type { ToolDefinition } from './registry.js';

export interface ToolPolicy {
    allow?: string[];
    deny?: string[];
}

const CATEGORY_PREFIX = 'category:';

function parseList(value: string | undefined): string[] | undefined {
    const entries = (value ?? '').split(',').map(e => e.trim()).filter(Boolean);
    return entries.length > 0 ? entries : undefined;
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): ToolPolicy {
    return {
        allow: parseList(env.MCP_DISCORD_ALLOW),
        deny: parseList(env.MCP_DISCORD_DENY),
    };
}

function matches(tool: ToolDefinition, entry: string): boolean {
    return entry.startsWith(CATEGORY_PREFIX)
        ? tool.category === entry.slice(CATEGORY_PREFIX.length)
        : tool.name === entry;
}

export function selectTools(tools: ToolDefinition[], policy: ToolPolicy): ToolDefinition[] {
    const { allow, deny = [] } = policy;

    const unknown = [...(allow ?? []), ...deny].filter(entry => !tools.some(t => matches(t, entry)));
    if (unknown.length > 0) {
        throw new Error(`Unknown tool policy entries: ${unknown.join(', ')}`);
    }

    return tools.filter(tool =>
        (!allow || allow.some(entry => matches(tool, entry))) &&
        !deny.some(entry => matches(tool, entry))
    );
}

/**
 * Schema for the `confirm` argument of a destructive tool. The value must repeat the
 * tool name, so the caller has to state which irreversible action it means to run.
 */
export function confirmSchema(toolName: string) {
    return z.literal(toolName).describe(
        `Required safety check: this action cannot be undone. Must be exactly "${toolName}". ` +
        'Only set it after the user has approved this specific action.'
    );
}
