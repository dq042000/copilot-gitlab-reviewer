import express from 'express';
import dotenv from 'dotenv';
// 注意：如果你使用 tsx 執行，不需要加 .js 後綴
import { handleUniversalReview } from './services/review.manager.js';

// 讀取 .env 設定
dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

app.post('/webhook', (req, res) => {
    // 1. 安全檢查：驗證 GitLab 傳來的 Secret Token
    const gitlabToken = req.headers['x-gitlab-token'];
    const expectedToken = WEBHOOK_SECRET;

    console.log(`[Webhook] 收到請求，來源 Token 長度: ${gitlabToken?.length || 0}`);
    
    if (expectedToken && gitlabToken !== expectedToken) {
        console.error('❌ Token 不匹配！');
        return res.status(403).send('Node App: Invalid Secret');
    }

    const payload = req.body;

    // 2. 只處理 Merge Request 事件
    if (payload.object_kind !== 'merge_request') {
        return res.status(200).send('Not a Merge Request event, skipping.');
    }

    // 取得目標分支名稱
    const targetBranch = payload.object_attributes.target_branch;
    const sourceBranch = payload.object_attributes.source_branch;

    // 設定你想要觸發 AI Review 的目標分支清單
    const allowedTargetBranches = ['develop', 'master', 'main', 'production'];

    if (!allowedTargetBranches.includes(targetBranch)) {
        console.log(`[跳過] 目標分支是 ${targetBranch}，不是指定的開發分支。`);
        return res.status(200).send(`Ignore review for branch: ${targetBranch}`);
    }

    console.log(`[觸發] 偵測到 ${sourceBranch} -> ${targetBranch} 的合併請求，開始 AI 審查...`);

    // GitLab 的 action 通常在 object_attributes 中
    const mrAction = payload.object_attributes?.action;
    console.log(`收到 MR 事件: ${payload.project?.name} (Action: ${mrAction})`);

    // 如果是 GitLab 的 "Test" 按鈕，action 有可能是 undefined，我們允許它通過以便測試
    const allowedActions = ['open', 'update', 'reopen', undefined];
    if (!allowedActions.includes(mrAction)) {
        return res.status(200).send(`Action "${mrAction}" ignored.`);
    }

    // 3. 立即回傳 202，避免 GitLab Webhook Timeout
    res.status(202).send('Review process triggered');

    // 4. 背景執行 Review 邏輯
    handleUniversalReview(payload)
        .then(() => console.log(`[MR !${payload.object_attributes.iid}] Review 任務處理完畢`))
        .catch((err: unknown) => {
            console.error(`[MR !${payload.object_attributes.iid}] Review 任務發生異常:`);
            console.error(err);
        });
});

app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 Copilot GitLab Reviewer 啟動成功`);
    console.log(`📡 監聽埠號: ${PORT}`);
    console.log(`🔗 Webhook 路徑: https://mcp.sfs.tw/code-review/webhook`);
    console.log(`========================================`);
});