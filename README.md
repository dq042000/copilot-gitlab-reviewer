# copilot-gitlab-reviewer

一個部署在自架伺服器上的 GitLab Webhook 服務，當有 Merge Request 建立或更新時，自動呼叫 **GitHub Copilot CLI** 對變更的程式碼進行 AI 審查，並將審查結果以留言方式回寫到 GitLab MR。

---

## 功能特色

- 接收 GitLab Webhook 的 Merge Request 事件
- 自動 Clone 來源分支並與目標分支進行 diff
- 逐一檔案呼叫 GitHub Copilot CLI (`@github/copilot`) 產生 AI 審查意見
- 將審查結果以 Markdown 留言形式發布到 GitLab MR
- 若審查過程發生任何錯誤，也會在 MR 留言通知工程師人工介入
- 支援只對指定目標分支（如 `master`、`develop`）觸發審查
- 以 PM2 背景執行，確保服務穩定運作

---

## 系統需求

| 項目 | 版本需求 |
|------|----------|
| Node.js | v18+ (建議使用 nvm 管理) |
| TypeScript | v5+ |
| GitHub Copilot CLI | `@github/copilot` (全域安裝) |
| PM2 | 全域安裝（正式環境用） |

---

## 安裝步驟

### 1. 安裝相依套件

```bash
npm install
```

### 2. 安裝 GitHub Copilot CLI

```bash
npm install -g @github/copilot
```

安裝完成後請確認已登入：

```bash
copilot --help
```

> 若使用 nvm，服務啟動時會自動從 `~/.nvm/versions/` 查找 `copilot` binary 的絕對路徑，無需手動設定 PATH。

### 3. 設定環境變數

複製範本並填入實際值：

```bash
cp env-sample .env
```

編輯 `.env`：

```dotenv
PORT=1689
GITLAB_URL=https://your-gitlab.example.com
GITLAB_PRIVATE_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
WEBHOOK_SECRET=your-random-secret-string
```

| 變數名稱 | 說明 |
|----------|------|
| `PORT` | 服務監聽的 Port |
| `GITLAB_URL` | GitLab 網址（不含結尾 `/`） |
| `GITLAB_PRIVATE_TOKEN` | GitLab Personal Access Token（需有 `api` 權限） |
| `WEBHOOK_SECRET` | GitLab Webhook 設定中填入的 Secret Token |

### 4. 建構 TypeScript

```bash
npm run build
```

---

## 啟動服務

### 開發模式（熱重載）

```bash
npm run dev
```

### 正式環境（PM2 背景執行）

```bash
npm run build
npm run review:bg
```

查看 PM2 狀態與日誌：

```bash
pm2 status
pm2 logs copilot-bot
```

---

## GitLab Webhook 設定

1. 進入 GitLab 專案 → **Settings → Webhooks**
2. 填入 Webhook URL：

   ```
   https://your-server.example.com/webhook
   ```

3. **Secret token** 填入 `.env` 中的 `WEBHOOK_SECRET`
4. 勾選觸發事件：**Merge request events**
5. 儲存後可按 **Test** 按鈕驗證連線

---

## 審查觸發條件

只有符合以下條件的 MR 事件才會觸發審查：

- **事件類型**：`merge_request`
- **MR Action**：`open`、`update`、`reopen`（或 GitLab Test 按鈕的 `undefined`）
- **目標分支**：`develop`、`master`、`main`、`production`（可在 `src/index.ts` 中調整）

---

## 專案結構

```
copilot-gitlab-reviewer/
├── src/
│   ├── index.ts                # Express 伺服器、Webhook 路由
│   └── services/
│       └── review.manager.ts   # 核心審查邏輯（Git diff + Copilot + GitLab API）
├── dist/                       # TypeScript 編譯輸出
├── .env                        # 環境變數（不進版控）
├── env-sample                  # 環境變數範本
├── package.json
└── tsconfig.json
```

---

## 審查流程說明

```
GitLab MR 事件
      │
      ▼
  驗證 Secret Token
      │
      ▼
  確認事件類型與目標分支
      │
      ▼
  git clone --depth 1 (來源分支)
      │
      ▼
  git fetch --depth 1 (目標分支)
      │
      ▼
  git diff FETCH_HEAD HEAD (取得變更檔案清單)
      │
      ▼
  逐一檔案 ──► copilot --prompt (AI 審查)
      │
      ▼
  POST /api/v4/projects/:id/merge_requests/:iid/notes
  (將審查結果寫入 GitLab MR 留言)
```

---

## 排除審查的檔案類型

以下路徑/類型的檔案會被自動略過：

- `dist/`
- `node_modules/`
- `*.lock`
- `vendor/`
- `.git/`

可在 `src/services/review.manager.ts` 的 `EXCLUDE_PATTERNS` 陣列中調整。

---

## 常見問題

**Q: 服務顯示 `copilot CLI 找不到`**  
A: 確認已執行 `npm install -g @github/copilot`，且 nvm 的 Node.js 版本與安裝時一致。

**Q: GitLab API 回傳 401**  
A: 確認 `GITLAB_PRIVATE_TOKEN` 具有 `api` scope，且 Token 未過期。

**Q: MR 沒有收到留言**  
A: 查看 PM2 日誌 `pm2 logs copilot-bot`，確認是否有 `Copilot 回覆為空` 或 `GitLab API 撥叫失敗` 的訊息。
