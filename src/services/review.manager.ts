import { spawnSync } from 'child_process';
import https from 'https';
import axios from 'axios';

// 停用 keep-alive，避免重複使用已關閉的連線造成 EPIPE 錯誤
const httpsAgent = new https.Agent({ keepAlive: false });

const EXCLUDE_PATTERNS = ['dist/', 'node_modules/', '*.lock', 'vendor/', '.git/'];
const GITLAB_API_BASE = () => process.env.GITLAB_URL || 'https://gitlab.cloudschool.com.tw';
const GITLAB_TOKEN = () => process.env.GITLAB_PRIVATE_TOKEN;

/**
 * 取得 MR 變更檔案
 */
async function getMrDiffs(projectId: number, mrIid: number): Promise<{ path: string; diff: string }[]> {
    const results: { path: string; diff: string }[] = [];
    try {
        const res = await axios.get(
            `${GITLAB_API_BASE()}/api/v4/projects/${projectId}/merge_requests/${mrIid}/changes`,
            {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN() },
                params: { per_page: 100 },
                timeout: 30000
            }
        );

        const changes = res.data?.changes ?? [];
        for (const d of changes) {
            const filePath: string = d.new_path || d.old_path;
            if (EXCLUDE_PATTERNS.some(p => filePath.includes(p))) continue;
            if (!d.diff || d.diff.trim() === '') continue;
            results.push({ path: filePath, diff: d.diff });
        }
    } catch (e) {
        console.error('取得 MR Diff 失敗:', e);
    }
    return results;
}

/**
 * 標注行號
 */
function annotateDiffWithLineNumbers(diff: string): string {
    const lines = diff.split('\n');
    const annotated: string[] = [];
    let newLineNum = 0;

    for (const line of lines) {
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

/**
 * 主流程：處理 Universal Review
 */
export const handleUniversalReview = async (payload: any) => {
    const { project, object_attributes } = payload;
    const projectId = project.id;
    const mrIid = object_attributes.iid;

    try {
        // 先發一則「審查中」提示，讓工程師知道 AI Review 已啟動
        await postToGitLab(
            projectId,
            mrIid,
            '',
            `⏳ **AI Code Review 進行中...**\n\n正在分析本次 MR 的程式碼變更，請稍候，審查結果將會發佈於此留言串。`
        );

        const mrDiffs = await getMrDiffs(projectId, mrIid);
        const filesToReview = mrDiffs.filter(({ path }) => !EXCLUDE_PATTERNS.some(p => path.includes(p)));

        if (filesToReview.length === 0) return;

        // 查找 Copilot CLI
        const homeDir = process.env.HOME || `/home/${process.env.USER}`;
        const copilotBin = spawnSync('/bin/bash', ['-c', `find "${homeDir}/.nvm/versions" -name "copilot" -type f 2>/dev/null | head -1 || which copilot 2>/dev/null || true`], { encoding: 'utf8' }).stdout.trim();
        
        if (!copilotBin) throw new Error('找不到 copilot CLI');
        
        const copilotVersion = spawnSync(copilotBin, ['--version'], { encoding: 'utf8' }).stdout.trim() || 'unknown';

        // 儲存審查結果
        const criticalIssues: string[] = []; // 存放有問題的結果
        const passedFiles: string[] = [];   // 存放 Pass 的檔名

        for (const { path: file, diff: fileDiff } of filesToReview) {
            const annotatedDiff = annotateDiffWithLineNumbers(fileDiff);

            const prompt = `你是一位資深工程師，請對以下 git diff 進行 Code Review。

## 審查原則：
1. **拒絕過度優化**：如果程式碼邏輯正確、可讀性高，且僅是「個人風格」或「微小效能提升（如變數命名）」，請視為通過。
2. **抓大放小**：優先關注潛在 Bug、安全性、邏輯錯誤或嚴重的維護性問題。
3. **針對性**：若此變更是根據前次建議修改的，除非有新產生的錯誤，否則請給予通過。

## 回覆格式：
- 若發現問題，請按原定 Markdown 格式回覆（🔴 嚴重 > 🟡 一般 > 🔵 建議）。
- 若該檔案「完全沒有」上述嚴重問題，請**僅回覆**一行字：【PASS】

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

以下是帶行號標注的 diff：
\`\`\`
${annotatedDiff}
\`\`\`
`;

            const result = spawnSync(copilotBin, ['--prompt', prompt], {
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024
            });

            const feedback = (result.stdout ?? '').trim();

            if (feedback.includes('【PASS】') || feedback === '') {
                passedFiles.push(file);
            } else {
                criticalIssues.push(feedback);
            }
        }

        // 構建最終報告內容
        let finalComment = `## 🤖 AI Code Review 報告\n\n`;
        finalComment += `本次共審查 **${filesToReview.length}** 個變更檔案。\n\n`;

        if (criticalIssues.length > 0) {
            finalComment += `### 🔍 審查發現 (${criticalIssues.length} 項建議)\n`;
            finalComment += criticalIssues.join('\n\n') + `\n\n`;
        }

        if (passedFiles.length > 0) {
            finalComment += `### ✅ 表現良好檔案\n`;
            finalComment += `<details>\n<summary>點擊展開查看已通過審查的檔案清單 (${passedFiles.length})</summary>\n\n`;
            finalComment += passedFiles.map(f => `- \`${f}\`：無發現明顯問題。`).join('\n');
            finalComment += `\n</details>\n\n`;
        }

        finalComment += `---\n_模型：GitHub Copilot | 版本：\`${copilotVersion}\`_`;

        // 只發送一則總結留言
        await postToGitLab(projectId, mrIid, '', finalComment);

    } catch (err: any) {
        console.error(`[${mrIid}] 流程出錯:`, err);
        await postToGitLab(projectId, mrIid, '', `🚨 AI Review 發生錯誤：\`${err.message}\``);
    }
};

async function postToGitLab(projectId: number, mrIid: number, filename: string, content: string, retries = 3) {
    const TOKEN = GITLAB_TOKEN();
    const body = filename ? `#### 🤖 AI Review: \`${filename}\`\n---\n${content}` : content;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await axios.post(
                `${GITLAB_API_BASE()}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`,
                { body },
                {
                    headers: { 'PRIVATE-TOKEN': TOKEN },
                    timeout: 30000,
                    httpsAgent
                }
            );
            return; // 成功即結束
        } catch (error: any) {
            const isEpipe = error?.code === 'EPIPE' || error?.message?.includes('EPIPE');
            console.error(`GitLab API 發佈失敗 (第 ${attempt}/${retries} 次):`, error?.message);
            if (attempt < retries && isEpipe) {
                // EPIPE 屬於暫時性網路問題，等待後重試
                await new Promise(r => setTimeout(r, attempt * 1000));
            } else {
                break;
            }
        }
    }
}