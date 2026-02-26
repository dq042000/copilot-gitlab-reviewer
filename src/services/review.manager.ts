import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import axios from 'axios';

const EXCLUDE_PATTERNS = ['dist/', 'node_modules/', '*.lock', 'vendor/', '.git/'];

export const handleUniversalReview = async (payload: any) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'copilot-review-'));
    
    const { project, object_attributes } = payload;
    const repoUrl = project.git_ssh_url;
    const sourceBranch = object_attributes.source_branch;
    const targetBranch = object_attributes.target_branch;
    const projectId = project.id;
    const mrIid = object_attributes.iid;

    try {
        console.log(`[${mrIid}] 正在 Clone 來源分支: ${sourceBranch}...`);
        // 1. 克隆來源分支 (Shallow)
        execSync(`git clone --depth 1 --branch ${sourceBranch} ${repoUrl} ${tempDir}`, {
            env: { ...process.env, GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=no' },
            stdio: 'ignore'
        });

        // 💡 關鍵修正：Fetch 目標分支時使用明確 refspec，確保 FETCH_HEAD 指向目標分支
        // 淺層 Clone (--depth 1) 沒有足夠的歷史記錄找到 merge base，
        // 因此不使用三點語法 (origin/x...HEAD)，改用 FETCH_HEAD 兩點 diff
        console.log(`[${mrIid}] 正在獲取目標分支基準: ${targetBranch}...`);
        execSync(
            `git -C ${tempDir} fetch --depth 1 origin +refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`,
            {
                env: { ...process.env, GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=no' },
                stdio: 'ignore'
            }
        );

        // 2. 獲取檔案列表（FETCH_HEAD 即剛 fetch 回來的目標分支最新 commit）
        const diffCmd = `git -C ${tempDir} diff --name-only FETCH_HEAD HEAD`;
        const changedFilesRaw = execSync(diffCmd, { encoding: 'utf8' });

        const filesToReview = changedFilesRaw
            .split('\n')
            .filter(file => file.trim() !== '' && !EXCLUDE_PATTERNS.some(p => file.includes(p)));

        console.log(`[${mrIid}] 待審查檔案數: ${filesToReview.length}`);

        // 解析 copilot CLI 路徑與版本（移到迴圈外，只查找一次）
        const homeDir = process.env.HOME || `/home/${process.env.USER}`;
        const copilotBin = execSync(
            `find "${homeDir}/.nvm/versions" -name "copilot" -type f 2>/dev/null | head -1 || which copilot 2>/dev/null || true`,
            { encoding: 'utf8', shell: '/bin/bash' }
        ).trim();

        if (!copilotBin) {
            throw new Error('找不到 copilot CLI，請確認已安裝 @github/copilot 並可在 PATH 中存取');
        }

        const copilotVersion = execSync(`"${copilotBin}" --version 2>/dev/null || echo 'unknown'`, {
            encoding: 'utf8', shell: '/bin/bash'
        }).trim();

        console.log(`[${mrIid}] 使用 Copilot CLI 版本: ${copilotVersion}`);

        // 發出「審查開始」通知留言
        await postToGitLab(
            projectId, mrIid, '',
            `🤖 **AI Code Review 已啟動**\n\n` +
            `> 正在分析本次 MR 的 **${filesToReview.length}** 個變更檔案，請稍候...\n\n` +
            `審查完成後將逐一回報各檔案的分析結果。\n\n` +
            `---\n_模型：GitHub Copilot｜CLI 版本：\`${copilotVersion}\`_`
        );

        for (const file of filesToReview) {
            try {
                const fileDiff = execSync(
                    `git -C ${tempDir} diff FETCH_HEAD HEAD -- "${file}"`,
                    { encoding: 'utf8' }
                );

                if (!fileDiff || fileDiff.trim() === '') continue;

                const prompt = `你是一位資深工程師。請審查以下代碼變動，針對潛在 Bug 或安全風險給予簡短建議。若無問題請回覆 "Looks good"。\n\n${fileDiff}`;

                // 使用 --prompt 旗標進行非互動式呼叫
                const feedback = execSync(
                    `"${copilotBin}" --prompt ${JSON.stringify(prompt)}`,
                    { encoding: 'utf8', shell: '/bin/bash' }
                );

                console.log(`[${mrIid}] Copilot 回覆 (${file}):`, feedback.trim().substring(0, 200));

                if (!feedback || feedback.trim() === '') {
                    console.log(`[${mrIid}] Copilot 回覆為空，跳過 ${file}`);
                } else {
                    console.log(`[${mrIid}] 正在發佈 Review 留言到 GitLab (${file})...`);
                    await postToGitLab(projectId, mrIid, file,
                        `${feedback.trim()}\n\n---\n_模型：GitHub Copilot｜CLI 版本：\`${copilotVersion}\`_`
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
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
        console.log(`[${mrIid}] 臨時目錄已清理`);
    }
};

async function postToGitLab(projectId: number, mrIid: number, filename: string, content: string) {
    const GITLAB_API = process.env.GITLAB_URL || 'https://gitlab.cloudschool.com.tw';
    const TOKEN = process.env.GITLAB_PRIVATE_TOKEN;

    try {
        const header = filename ? `#### 🤖 AI Review: \`${filename}\`\n---\n` : '';
        await axios.post(
            `${GITLAB_API}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`,
            { body: `${header}${content}` },
            { headers: { 'PRIVATE-TOKEN': TOKEN } }
        );
    } catch (error: any) {
        console.error(`GitLab API 撥叫失敗 [project=${projectId}, mr=${mrIid}, file=${filename}]:`);
        console.error('Status:', error?.response?.status);
        console.error('Data:', JSON.stringify(error?.response?.data));
        console.error('Message:', error?.message);
    }
}