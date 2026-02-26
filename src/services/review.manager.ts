import { spawnSync } from 'child_process';
import axios from 'axios';

const EXCLUDE_PATTERNS = ['dist/', 'node_modules/', '*.lock', 'vendor/', '.git/'];
const GITLAB_API_BASE = () => process.env.GITLAB_URL || 'https://gitlab.cloudschool.com.tw';
const GITLAB_TOKEN = () => process.env.GITLAB_PRIVATE_TOKEN;

/**
 * 透過 GitLab API 取得 MR 真正變更的檔案 diff 清單。
 * 相較於 git diff，API 回傳的是 GitLab 計算後的 MR diff，不受淺層 clone 影響。
 */
async function getMrDiffs(projectId: number, mrIid: number): Promise<{ path: string; diff: string }[]> {
    const results: { path: string; diff: string }[] = [];
    let page = 1;

    while (true) {
        const res = await axios.get(
            `${GITLAB_API_BASE()}/api/v4/projects/${projectId}/merge_requests/${mrIid}/changes`,
            {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN() },
                params: { per_page: 50, page },
                timeout: 30000
            }
        );

        // /changes 回傳格式：{ changes: [...], ... }
        const changes: any[] = res.data?.changes ?? res.data ?? [];
        if (!changes || changes.length === 0) break;

        for (const d of changes) {
            const filePath: string = d.new_path || d.old_path;
            if (EXCLUDE_PATTERNS.some(p => filePath.includes(p))) continue;
            if (!d.diff || d.diff.trim() === '') continue;
            results.push({ path: filePath, diff: d.diff });
        }

        // /changes 不支援分頁（一次回傳全部），取得後直接跳出
        break;
    }

    return results;
}

/**
 * 解析 git diff，在每一行前標注實際的新檔案行號，讓 Copilot 能精確引用。
 * 輸出格式範例：
 *   [L42 +] $result = $this->find();
 *   [L43  ] $data = [];
 */
function annotateDiffWithLineNumbers(diff: string): string {
    const lines = diff.split('\n');
    const annotated: string[] = [];
    let newLineNum = 0;

    for (const line of lines) {
        // 解析 hunk header: @@ -old,count +new,count @@
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            newLineNum = parseInt(hunkMatch[1] ?? '0', 10) - 1;
            annotated.push(line);
            continue;
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
            newLineNum++;
            annotated.push(`[L${newLineNum} +] ${line.slice(1)}`);
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            annotated.push(`[DEL  -] ${line.slice(1)}`);
        } else if (line.startsWith(' ')) {
            newLineNum++;
            annotated.push(`[L${newLineNum}  ] ${line.slice(1)}`);
        } else {
            annotated.push(line);
        }
    }
    return annotated.join('\n');
}

export const handleUniversalReview = async (payload: any) => {
    const { project, object_attributes } = payload;
    const projectId = project.id;
    const mrIid = object_attributes.iid;

    try {
        // 1. 透過 GitLab API 取得本次 MR 的真實變更 diff（不受淺層 clone 影響）
        console.log(`[${mrIid}] 正在透過 GitLab API 取得 MR diff...`);
        const mrDiffs = await getMrDiffs(projectId, mrIid);

        const filesToReview = mrDiffs.filter(
            ({ path }) => !EXCLUDE_PATTERNS.some(p => path.includes(p))
        );

        console.log(`[${mrIid}] 待審查檔案數: ${filesToReview.length}`);

        // 解析 copilot CLI 路徑與版本（移到迴圈外，只查找一次）
        const homeDir = process.env.HOME || `/home/${process.env.USER}`;
        const copilotBin = spawnSync(
            '/bin/bash',
            ['-c', `find "${homeDir}/.nvm/versions" -name "copilot" -type f 2>/dev/null | head -1 || which copilot 2>/dev/null || true`],
            { encoding: 'utf8' }
        ).stdout.trim();

        if (!copilotBin) {
            throw new Error('找不到 copilot CLI，請確認已安裝 @github/copilot 並可在 PATH 中存取');
        }

        const copilotVersion = spawnSync(copilotBin, ['--version'], { encoding: 'utf8' })
            .stdout.trim() || 'unknown';

        console.log(`[${mrIid}] 使用 Copilot CLI 版本: ${copilotVersion}`);

        // 發出「審查開始」通知留言
        await postToGitLab(
            projectId, mrIid, '',
            `🤖 **AI Code Review 已啟動**\n\n` +
            `> 正在分析本次 MR 的 **${filesToReview.length}** 個變更檔案，請稍候...\n\n` +
            `審查完成後將逐一回報各檔案的分析結果。\n\n` +
            `---\n_模型：GitHub Copilot｜CLI 版本：\`${copilotVersion}\`_`
        );

        for (const { path: file, diff: fileDiff } of filesToReview) {
            try {
                if (!fileDiff || fileDiff.trim() === '') continue;

                const annotatedDiff = annotateDiffWithLineNumbers(fileDiff);

                const prompt = `你是一位資深工程師，請對以下 git diff 進行 Code Review。

diff 中每行前綴說明：
- [L42 +] 表示新增的第 42 行
- [DEL  -] 表示被刪除的行
- [L42  ] 表示未變更的上下文行

請用以下 Markdown 格式回覆（若無問題，最後僅輸出「✅ 無發現明顯問題」即可）：

---
### 🔴 問題 N：簡短標題

**行號**：第 X 行
**問題程式碼**：
\`\`\`
貼上有問題的那行或數行程式碼
\`\`\`
**說明**：說明為何有問題
**建議修正**：
\`\`\`
修正後的程式碼範例
\`\`\`
---

每個問題獨立一個區塊，嚴重依序排列（🔴 嚴重 > 🟡 一般 > 🔵 建議）。
若無問題，請直接回覆：✅ 無發現明顯問題

以下是帶行號標注的 diff：
\`\`\`
${annotatedDiff}
\`\`\`
`;

                // 使用 spawnSync 分別捕捉 stdout（AI 回覆）與 stderr（模型資訊）
                const result = spawnSync(copilotBin, ['--prompt', prompt], {
                    encoding: 'utf8',
                    shell: false,
                    maxBuffer: 10 * 1024 * 1024
                });

                if (result.error) throw result.error;

                const feedback = result.stdout ?? '';
                // stderr 內含模型用量，例如：gpt-5-mini  14.0k in, 729 out, 0 cached (Est. 0 Premium requests)
                const modelUsage = (result.stderr ?? '').trim();

                console.log(`[${mrIid}] Copilot 回覆 (${file}):`, feedback.trim().substring(0, 200));
                if (modelUsage) console.log(`[${mrIid}] 模型資訊:`, modelUsage);

                if (!feedback || feedback.trim() === '') {
                    console.log(`[${mrIid}] Copilot 回覆為空，跳過 ${file}`);
                } else {
                    const modelLine = modelUsage ? `\n_模型資訊：\`${modelUsage}\`_` : `\n_CLI 版本：\`${copilotVersion}\`_`;
                    console.log(`[${mrIid}] 正在發佈 Review 留言到 GitLab (${file})...`);
                    await postToGitLab(projectId, mrIid, file,
                        `${feedback.trim()}\n\n---${modelLine}`
                    );
                }
            } catch (e: any) {
                console.error(`[${mrIid}] 檔案 ${file} 審查中斷:`, e);
                await postToGitLab(
                    projectId, mrIid, file,
                    `⚠️ 此檔案的 AI Review 發生錯誤，請人工審查。\n\n\`\`\`\n${e?.message ?? String(e)}\n\`\`\``
                );
            }
        }
    } catch (err: any) {
        console.error(`[${mrIid}] 流程出錯:`, err);
        try {
            await postToGitLab(
                projectId, mrIid, '（整體流程）',
                `🚨 AI Review 流程發生嚴重錯誤，本次審查未完成，請人工審查。\n\n\`\`\`\n${err?.message ?? String(err)}\n\`\`\``
            );
        } catch (_) { /* 避免通知失敗再次拋出 */ }
        throw err;
    }
};

async function postToGitLab(projectId: number, mrIid: number, filename: string, content: string, retries = 3) {
    const GITLAB_API = process.env.GITLAB_URL || 'https://gitlab.cloudschool.com.tw';
    const TOKEN = process.env.GITLAB_PRIVATE_TOKEN;

    // GitLab note 限制約 1MB，保守截斷在 30000 字元
    const MAX_LENGTH = 30000;
    const truncated = content.length > MAX_LENGTH
        ? content.slice(0, MAX_LENGTH) + '\n\n> ⚠️ _內容過長已截斷，請查看完整日誌_'
        : content;

    const header = filename ? `#### 🤖 AI Review: \`${filename}\`\n---\n` : '';
    const body = `${header}${truncated}`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await axios.post(
                `${GITLAB_API}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`,
                { body },
                {
                    headers: { 'PRIVATE-TOKEN': TOKEN },
                    timeout: 30000  // 30 秒逾時
                }
            );
            return; // 成功即離開
        } catch (error: any) {
            const isLastAttempt = attempt === retries;
            console.error(`GitLab API 撥叫失敗 (第 ${attempt}/${retries} 次) [project=${projectId}, mr=${mrIid}, file=${filename}]:`);
            console.error('Status:', error?.response?.status);
            console.error('Message:', error?.message);
            if (isLastAttempt) {
                console.error('Data:', JSON.stringify(error?.response?.data));
                return;
            }
            // 等待後重試（指數退避：1s, 2s, 4s）
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
    }
}