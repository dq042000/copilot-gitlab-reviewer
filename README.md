## 專案說明

`copilot-gitlab-reviewer` 是一個 GitLab Webhook 服務。
當 MR 事件或 `/ai-review` 留言觸發時，服務會讀取 MR diff，
用 `@github/copilot-sdk` 呼叫 Copilot 進行審查，最後回寫
到 GitLab MR 留言。

## 部署前檢查清單

- 已設定 `GITLAB_URL`、`GITLAB_PRIVATE_TOKEN`、`WEBHOOK_SECRET`
- `GITLAB_PRIVATE_TOKEN` 與 `COPILOT_API_KEY` / `GITHUB_TOKEN` 未混用
- `copilot --help` 可正常執行（必要時設定 `COPILOT_CLI_PATH`）
- GitLab Webhook 已啟用 `Merge request events`（留言觸發需 `Note events`）
- 先用 `POST /trigger` 測一筆，確認 MR 可收到「審查中」與最終報告

## 功能重點

- 支援兩種觸發方式：MR 事件、MR 留言 `/ai-review`
- 先發「審查中」訊息，再發送最終整合報告
- 只審查指定目標分支（`develop`、`master`、`main`、`production`）
- 支援排除路徑（`dist/`、`node_modules/`、`*.lock`、`vendor/`、`.git/`）
- 留言報告會顯示使用的 model 與 SDK 資訊

## 系統需求

| 項目 | 版本 |
|---|---|
| Node.js | 18+（建議用 nvm） |
| npm | 9+ |
| Copilot CLI | `@github/copilot`（建議全域安裝） |
| PM2 | 正式環境建議使用 |

## 安裝與啟動

### 1) 安裝相依套件

```bash
npm install
```

### 2) 安裝 Copilot CLI（SDK 會使用）

```bash
npm install -g @github/copilot
copilot --help
```

### 3) 建立環境變數

```bash
cp env-sample .env
```

`.env` 主要欄位如下：

| 變數 | 用途 | 必填 |
|---|---|---|
| `PORT` | 服務埠號 | 否（預設 3000） |
| `GITLAB_URL` | GitLab 主站 URL | 是 |
| `GITLAB_PRIVATE_TOKEN` | GitLab API token（讀 MR / 發 MR 留言） | 是 |
| `WEBHOOK_SECRET` | GitLab Webhook secret | 建議 |
| `ADMIN_TOKEN` | `/trigger` 端點保護 token | 否 |
| `REVIEW_CONCURRENCY` | 同時審查檔案數 | 否（預設 3） |
| `COPILOT_MODEL` | 審查模型名稱 | 否（預設 `gpt-5-mini`） |
| `COPILOT_CLI_PATH` | 指定 copilot 執行檔路徑 | 否 |
| `COPILOT_API_KEY` | Copilot/GitHub token（與下列欄位擇一） | 否 |
| `GITHUB_TOKEN` | Copilot token 替代欄位 | 否 |

認證建議與 GITLAB_PRIVATE_TOKEN 使用說明：

- 建議不要與 Copilot token 共用，GitLab token 與 Copilot（GitHub）token 分開管理。

- 建立 Personal Access Token（使用者設定 -> Access Tokens）：
  1. 前往 GitLab 上方使用者頭像 > Settings > Access Tokens。
  2. 填寫 Name，建議設定 Expiration date（過期日）。
  3. 權限（Scopes）建議：
     - `api`（建議）：能存取 MR、notes、repository 等所有需要的 API。
     - 若只需讀取 private repository 的 diff，可改為只勾選 `read_repository`（較小權限）。

- 也可以使用 Project Access Token / Deploy Token（Project Settings -> Repository -> Deploy Tokens），但請確認所用 token 有權限讀取 MR 並發表留言。

- 設定方式：將產生的 token 放入伺服器的 `.env`（例如 `GITLAB_PRIVATE_TOKEN=xxxx`），或在部署平台／CI 的環境變數中設定（例如 GitLab：Project -> Settings -> CI/CD -> Variables）。切勿將 token 提交到版本控制；在可能的情況下設定過期日與定期輪換。

- 最佳實務：僅授權最小必要權限、設定過期日、並使用環境變數或秘密管理服務保護 token。

### 4) 開發模式

```bash
npm run dev
```

### 5) 正式環境（PM2）

```bash
npm run build
npm run start:bg
```

常用 PM2 指令：

```bash
npm run start:logs
npm run start:restart
npm run start:stop
npm run start:remove
```

## GitLab Webhook 設定

Webhook URL：

```text
https://<your-domain>/webhook
```

GitLab 專案設定：

- `Settings` → `Webhooks`
- `URL`：填入上面的 `/webhook`
- `Secret token`：填入 `WEBHOOK_SECRET`
- 觸發事件建議至少勾選：`Merge request events`
- 需使用留言觸發 `/ai-review` 時，請另外啟用 `Note events`

## API 與觸發

### `POST /webhook`

- 驗證 `x-gitlab-token`（若設定了 `WEBHOOK_SECRET`）
- 支援：
    - MR 事件（`open` / `update` / `reopen` / GitLab test 的 `undefined`）
    - MR 留言事件，留言內容完全等於 `/ai-review`

### `POST /trigger`

手動觸發審查（可搭配 `x-admin-token`）：

```bash
curl -X POST 'http://localhost:1689/trigger' \
    -H 'Content-Type: application/json' \
    -H 'x-admin-token: <ADMIN_TOKEN>' \
    -d '{"projectId":47,"mrIid":7}'
```

## 審查流程（目前實作）

1. 接收事件並驗證 secret
2. 取得 MR 變更：`GET /api/v4/projects/:id/merge_requests/:iid/changes`
3. 過濾排除檔案後逐檔送入 Copilot SDK
4. 彙整結果後留言到 MR：
     `POST /api/v4/projects/:id/merge_requests/:iid/notes`

## 專案結構

```text
src/
    index.ts
    services/
        copilot.client.ts
        review.manager.ts
env-sample
package.json
tsconfig.json
```

## 常見問題

### 1) `Authorization error, you may need to run /login`

- 若使用 token，請確認 `COPILOT_API_KEY` / `GITHUB_TOKEN` 對應帳號有 Copilot 使用權限
- 若使用 CLI 已登入模式，清空 token 變數後以服務執行帳號重新登入 Copilot CLI

### 2) GitLab API 401 / 404

- 確認 `GITLAB_PRIVATE_TOKEN` 正確且有 `api` 權限
- 確認 `projectId`、`mrIid` 與 `GITLAB_URL` 正確

### 3) 找不到 Copilot CLI

- 確認 `copilot --help` 可執行
- 必要時設定 `COPILOT_CLI_PATH`
