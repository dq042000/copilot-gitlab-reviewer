import { CopilotClient, approveAll } from '@github/copilot-sdk';

export default async function createCopilotClient() {
    const githubToken = process.env.COPILOT_API_KEY || process.env.GITHUB_TOKEN;
    const model = process.env.COPILOT_MODEL || 'gpt-5-mini';
    const cliPath = process.env.COPILOT_CLI_PATH;

    const clientOptions: ConstructorParameters<typeof CopilotClient>[0] = {
        useLoggedInUser: !githubToken,
    };

    if (githubToken) {
        clientOptions.githubToken = githubToken;
    }
    if (cliPath) {
        clientOptions.cliPath = cliPath;
    }

    const client = new CopilotClient(clientOptions);

    await client.start();

    async function generate(prompt: string): Promise<string> {
        let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
        try {
            session = await client.createSession({
                model,
                onPermissionRequest: approveAll,
                streaming: false,
            });

            const response = await session.sendAndWait({ prompt }, 120000);
            return response?.data?.content?.trim() || '';
        } catch (err: any) {
            throw new Error(`copilot SDK 產生回覆失敗: ${err?.message ?? err}`);
        } finally {
            if (session) {
                await session.destroy().catch(() => undefined);
            }
        }
    }

    async function close(): Promise<void> {
        await client.stop();
    }

    return { generate, close, version: '@github/copilot-sdk' };
}
