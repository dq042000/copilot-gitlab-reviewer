export default async function createCopilotClient() {
    const apiKey = process.env.COPILOT_API_KEY || process.env.GITHUB_TOKEN;
    if (!apiKey) throw new Error('請設定 COPILOT_API_KEY 或 GITHUB_TOKEN');

    const mod: any = await import('@github/copilot-sdk').catch((err) => {
        throw new Error('無法載入 @github/copilot-sdk: ' + (err?.message ?? err));
    });

    const pkgVersion = mod?.version || mod?.default?.version || 'unknown';

    let client: any;
    if (typeof mod.createCopilotClient === 'function') client = mod.createCopilotClient({ apiKey });
    else if (typeof mod.createClient === 'function') client = mod.createClient({ apiKey });
    else if (typeof mod.default === 'function') client = mod.default({ apiKey });
    else if (typeof mod.Copilot === 'function') client = new mod.Copilot({ apiKey });
    else client = mod;

    async function generate(prompt: string): Promise<string> {
        try {
            if (client?.chat?.completions?.create) {
                const r = await client.chat.completions.create({
                    model: process.env.COPILOT_MODEL || 'gpt-4o-mini',
                    messages: [{ role: 'user', content: prompt }],
                });
                return r?.choices?.[0]?.message?.content ?? r?.output ?? JSON.stringify(r);
            }

            if (client?.completions?.create) {
                const r = await client.completions.create({
                    model: process.env.COPILOT_MODEL || 'gpt-4o-mini',
                    prompt,
                    max_tokens: 2000,
                });
                return r?.choices?.[0]?.text ?? r?.output ?? JSON.stringify(r);
            }

            if (typeof client.generate === 'function') {
                const r = await client.generate(prompt);
                return r?.text ?? r?.output ?? JSON.stringify(r);
            }

            if (typeof client.request === 'function') {
                const r = await client.request({ prompt });
                return r?.output ?? JSON.stringify(r);
            }

            throw new Error('copilot client 不支援已知的呼叫方式');
        } catch (err: any) {
            throw new Error(`copilot SDK 產生回覆失敗: ${err?.message ?? err}`);
        }
    }

    return { generate, version: pkgVersion };
}
