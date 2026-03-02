# copilot-gitlab-reviewer

一個部署在自架伺服器上的 GitLab Webhook 服務，當有 Merge Request 建立或更新時，自動透過 **`@github/copilot-sdk`**（底層控制 Copilot CLI）對變更的程式碼進行 AI 審查，並將審查結果以留言方式回寫到 GitLab MR。

---

## 功能特色

- 接收 GitLab Webhook 的 Merge Request 事件
- 自動 Clone 來源分支並與目標分支進行 diff
- 逐一檔案透過 `@github/copilot-sdk` 產生 AI 審查意見
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

### 2. 安裝 GitHub Copilot CLI（供 SDK 使用）

```bash
npm install -g @github/copilot
```

安裝完成後請確認可正常執行：

```bash
copilot --help
```

> 若 CLI 不在預設 PATH，可設定 `.env` 的 `COPILOT_CLI_PATH` 指定執行檔路徑。

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
COPILOT_API_KEY=ghp_xxxxxxxxxxxxxxxxxxxx
# 或使用 GITHUB_TOKEN（二擇一）
# GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
WEBHOOK_SECRET=your-random-secret-string
COPILOT_MODEL=gpt-5-mini
```

| 變數名稱 | 說明 |
|----------|------|
| `PORT` | 服務監聽的 Port |
| `GITLAB_URL` | GitLab 網址（不含結尾 `/`） |
| `GITLAB_PRIVATE_TOKEN` | GitLab Personal Access Token（需有 `api` 權限） |
| `COPILOT_API_KEY` | Copilot/GitHub Token（供 `@github/copilot-sdk` 使用） |
| `GITHUB_TOKEN` | Copilot Token 替代欄位（與 `COPILOT_API_KEY` 擇一） |
| `WEBHOOK_SECRET` | GitLab Webhook 設定中填入的 Secret Token |
| `COPILOT_MODEL` | Copilot 模型名稱（預設 `gpt-5-mini`） |
| `COPILOT_CLI_PATH` | Copilot CLI 路徑（選填） |

> 建議將 `GITLAB_PRIVATE_TOKEN` 與 `COPILOT_API_KEY` 分開，不要共用同一把 Token。

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
npm run start:bg
```

查看 PM2 狀態與日誌：

```bash
pm2 status
pm2 logs copilot-bot
```

---

## GitLab Webhook 設定

### 步驟一：取得 Webhook URL

確認服務已啟動並可從外部存取，Webhook URL 格式為：

```
https://your-server.example.com/webhook
```

### 步驟二：產生 Secret Token

建議使用以下指令產生一組隨機 Token，並填入 `.env` 的 `WEBHOOK_SECRET`：

```bash
openssl rand -base64 60 | tr -d '\n'
```

### 步驟三：在 GitLab 新增 Webhook

1. 進入要設定的 GitLab **專案頁面**
2. 點選左側選單 **Settings（設定）**
3. 點選 **Webhooks**
4. 點選右上角 **Add new webhook** 按鈕
5. 填入以下欄位：

   | 欄位 | 填入值 |
   |------|--------|
   | **URL** | `https://your-server.example.com/webhook` |
   | **Secret token** | `.env` 中的 `WEBHOOK_SECRET` 值 |
   | **Trigger** | 勾選 ✅ **Merge request events** |
   | **Enable SSL verification** | 啟用（若為自簽憑證可視情況關閉） |

6. 點選 **Add webhook** 儲存

### 步驟四：測試 Webhook 連線

1. 儲存後，在 Webhook 列表中找到剛新增的項目
2. 點選右側 **Test** 下拉選單
3. 選擇 **Merge request events**
4. GitLab 會送出一筆測試請求，確認服務回傳 `202 Accepted`
5. 同時查看伺服器日誌確認收到請求：

   ```bash
   pm2 logs copilot-bot
   # 應看到：[Webhook] 收到請求，來源 Token 長度: xxx
   ```

> **注意**：GitLab Test 按鈕送出的 MR action 為 `undefined`，服務已允許此情況通過，方便測試連線是否正常。

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
    逐一檔案 ──► @github/copilot-sdk (AI 審查)
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
A: 確認已執行 `npm install -g @github/copilot`，若路徑非預設，請設定 `COPILOT_CLI_PATH`。

**Q: GitLab API 回傳 401**  
A: 確認 `GITLAB_PRIVATE_TOKEN` 具有 `api` scope，且不要誤用 `COPILOT_API_KEY` 當作 GitLab Token。

**Q: MR 沒有收到留言**  
A: 查看 PM2 日誌 `pm2 logs copilot-bot`，確認是否有 `Copilot 回覆為空` 或 `GitLab API 撥叫失敗` 的訊息。
