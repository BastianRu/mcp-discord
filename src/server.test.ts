// src/server.test.ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './server.js';
import { allTools, type ToolDefinition } from './tools/registry.js';
import { policyFromEnv, selectTools } from './tools/policy.js';
import type { DiscordProvider } from './providers/discord-provider.js';

const provider = { isReady: () => true } as unknown as DiscordProvider;

function fakeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
    return {
        name: 'fake_tool',
        description: 'fake',
        schema: z.object({ id: z.string() }),
        handler: vi.fn().mockResolvedValue({ ok: true }),
        category: 'other',
        ...overrides,
    };
}

async function connect(options: Partial<Parameters<typeof createMcpServer>[0]> = {}) {
    const server = createMcpServer({ provider, policy: {}, ...options });
    const client = new Client({ name: 'test', version: '0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
}

/** Protocol-level rejections may surface as a thrown error or as an isError result. */
async function callOutcome(client: Client, name: string, args: Record<string, unknown>) {
    return client.callTool({ name, arguments: args }).catch(err => ({ isError: true, thrown: err }));
}

describe('selectTools', () => {
    const tools = [
        fakeTool({ name: 'a', category: 'channels' }),
        fakeTool({ name: 'b', category: 'channels' }),
        fakeTool({ name: 'c', category: 'moderation' }),
    ];
    const names = (policy: Parameters<typeof selectTools>[1]) => selectTools(tools, policy).map(t => t.name);

    it('exposes everything without a policy', () => {
        expect(names({})).toEqual(['a', 'b', 'c']);
    });

    it('filters by tool name and by category', () => {
        expect(names({ allow: ['c'] })).toEqual(['c']);
        expect(names({ allow: ['category:channels'] })).toEqual(['a', 'b']);
    });

    it('lets deny win over allow', () => {
        expect(names({ allow: ['category:channels'], deny: ['b'] })).toEqual(['a']);
    });

    it('rejects unknown entries instead of ignoring them', () => {
        expect(() => names({ deny: ['typo'] })).toThrow(/typo/);
        expect(() => names({ allow: ['category:nope'] })).toThrow(/category:nope/);
    });
});

describe('policyFromEnv', () => {
    it('trims entries and treats empty values as unset', () => {
        expect(policyFromEnv({ MCP_DISCORD_ALLOW: ' a, category:b ,', MCP_DISCORD_DENY: '' }))
            .toEqual({ allow: ['a', 'category:b'], deny: undefined });
    });
});

describe('createMcpServer barriers', () => {
    const gatedTool = () => fakeTool({ isDestructive: true, requiresConfirmation: true });

    it('does not run a destructive tool without confirm', async () => {
        const tool = gatedTool();
        const client = await connect({ extraTools: [tool], policy: { allow: ['fake_tool'] } });

        const result = await callOutcome(client, 'fake_tool', { id: '1' });

        expect(result.isError).toBe(true);
        expect(tool.handler).not.toHaveBeenCalled();
    });

    it('does not run a destructive tool with the wrong confirm value', async () => {
        const tool = gatedTool();
        const client = await connect({ extraTools: [tool], policy: { allow: ['fake_tool'] } });

        const result = await callOutcome(client, 'fake_tool', { id: '1', confirm: 'yes' });

        expect(result.isError).toBe(true);
        expect(tool.handler).not.toHaveBeenCalled();
    });

    it('runs with the matching confirm and strips it from the handler input', async () => {
        const tool = gatedTool();
        const client = await connect({ extraTools: [tool], policy: { allow: ['fake_tool'] } });

        const result = await callOutcome(client, 'fake_tool', { id: '1', confirm: 'fake_tool' });

        expect(result.isError).toBeFalsy();
        expect(tool.handler).toHaveBeenCalledWith({ id: '1' }, provider);
    });

    it('does not require confirm on non-destructive tools', async () => {
        const tool = fakeTool();
        const client = await connect({ extraTools: [tool], policy: { allow: ['fake_tool'] } });

        const result = await callOutcome(client, 'fake_tool', { id: '1' });

        expect(result.isError).toBeFalsy();
        expect(tool.handler).toHaveBeenCalledOnce();
    });

    it('requires confirm and sets destructiveHint on every destructive built-in tool', async () => {
        const client = await connect();
        const { tools } = await client.listTools();
        const destructive = allTools.filter(t => t.requiresConfirmation).map(t => t.name);

        expect(destructive.length).toBeGreaterThan(0);
        for (const name of destructive) {
            const listed = tools.find(t => t.name === name)!;
            expect(listed.inputSchema.required, name).toContain('confirm');
            expect(listed.annotations?.destructiveHint, name).toBe(true);
        }
    });

    it('does not expose or run tools the policy removes', async () => {
        const client = await connect({ policy: { deny: ['category:moderation'] } });
        const { tools } = await client.listTools();

        expect(tools.some(t => t.name === 'ban_user')).toBe(false);
        expect(tools.some(t => t.name === 'get_channels')).toBe(true);
        const result = await callOutcome(client, 'ban_user', { guild_id: '1', user_id: '2' });
        expect(result.isError).toBe(true);
    });
});
