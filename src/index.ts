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

// ── 手動觸發端點：POST /trigger ─────────────────────────────────────────────
// 用法範例：
//   curl -X POST 'http://localhost:3000/trigger' \
//        -H 'Content-Type: application/json' \
//        -d '{"projectId": 47, "mrIid": 4}'
app.post('/trigger', async (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN;
    const reqToken   = req.headers['x-admin-token'] as string | undefined;

    if (adminToken && reqToken !== adminToken) {
        return res.status(403).json({ error: 'Invalid ADMIN_TOKEN' });
    }

    const projectId = Number(req.body?.projectId);
    const mrIid     = Number(req.body?.mrIid);

    if (!projectId || !mrIid) {
        return res.status(400).json({ error: 'projectId 與 mrIid 為必填欄位' });
    }

    console.log(`[手動觸發] project=${projectId}, mr=${mrIid}`);
    res.status(202).json({ message: `已排入審查：project=${projectId}, mr=${mrIid}` });

    // 組成最小化 payload 直接呼叫 handleUniversalReview
    const fakePayload = {
        project: { id: projectId },
        object_attributes: { iid: mrIid, action: 'manual' }
    };

    handleUniversalReview(fakePayload)
        .then(() => console.log(`[手動觸發] MR !${mrIid} 審查完畢`))
        .catch((err: unknown) => console.error(`[手動觸發] MR !${mrIid} 審查異常:`, err));
});

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

    // 2. 處理 MR 留言觸發（note 事件：在 MR 留言 /ai-review）
    if (payload.object_kind === 'note') {
        const noteBody: string = payload.object_attributes?.note ?? '';
        const noteableType: string = payload.object_attributes?.noteable_type ?? '';

        // Debug：印出完整 note payload 關鍵欄位，方便排查
        console.log(`[Note DEBUG] object_kind=${payload.object_kind}`);
        console.log(`[Note DEBUG] noteable_type=${noteableType}`);
        console.log(`[Note DEBUG] note="${noteBody.trim()}"`);
        console.log(`[Note DEBUG] has merge_request=${!!payload.merge_request}`);
        console.log(`[Note DEBUG] merge_request.iid=${payload.merge_request?.iid}`);
        console.log(`[Note DEBUG] object_attributes.noteable_id=${payload.object_attributes?.noteable_id}`);

        const isMrNote = noteableType === 'MergeRequest' || !!payload.merge_request;

        if (isMrNote && noteBody.trim().toLowerCase() === '/ai-review') {
            // noteable_id 是 MR 的 internal id（iid），優先從 merge_request.iid 取得
            const projectId = payload.project?.id;
            const mrIid     = payload.merge_request?.iid ?? payload.object_attributes?.noteable_iid;
            console.log(`[留言觸發] /ai-review 指令，project=${projectId}, mr=${mrIid}`);
            res.status(202).send('Review triggered by comment');

            const fakePayload = {
                project: { id: projectId },
                object_attributes: { iid: mrIid, action: 'manual' }
            };
            handleUniversalReview(fakePayload)
                .then(() => console.log(`[留言觸發] MR !${mrIid} 審查完畢`))
                .catch((err: unknown) => console.error(`[留言觸發] MR !${mrIid} 審查異常:`, err));
            return;
        }
        console.log(`[Note] 非 /ai-review 指令或非 MR 留言，略過。`);
        return res.status(200).send('Note ignored.');
    }

    // 3. 只處理 Merge Request 事件
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
    console.log(`🔁 手動觸發: POST /trigger  { projectId, mrIid }`);
    console.log(`💬 留言觸發: 在 MR 留言 /ai-review`);
    console.log(`========================================`);
});