# CR Image Refiner

記事用クリエイティブと自由入力画像を `gpt-image-2` で生成するWebスタジオです。ローカル実行と、GitHub Pages + GitHub Actionsによるバックグラウンド生成の2モードに対応します。

## 主な機能

- 記事画像制作: 依頼入力 → AI要件化 → 4案生成 → 確認 → 採用・修正
- 記事案件に紐づかないフリー画像生成
- 採用画像をブラウザのIndexedDBへ3日間保存
- 履歴画像の複数選択削除、全削除、使用容量表示
- テンプレートをIndexedDBへ15日保存し、期限延長・削除
- GitHub PagesからActionsを起動し、画面上で生成完了まで待機

## ローカル実行

Node.js 20以上が必要です。

```bash
cp .env.example .env
npm install
```

`.env`へ設定します。

```dotenv
OPENAI_API_KEY=sk-...
SITE_PASSWORD=十分に長いパスワード
```

起動:

```bash
npm run dev
```

[http://localhost:3000/studio](http://localhost:3000/studio) を開き、`SITE_PASSWORD`でログインします。停止は起動したターミナルで `Ctrl+C` です。

## GitHub Pages + Actions

リポジトリSecret `OPENAI_API_KEY` を画像生成Workflowが利用します。`SITE_PASSWORD` は依頼文の暗号化・復号に利用します。APIキーがブラウザやPagesへ配信されることはありません。

1. GitHubの **Settings → Pages → Build and deployment** で Source を **GitHub Actions** にします。
2. `main` へpushすると `.github/workflows/deploy-pages.yml` が静的UIを公開します。
3. Pagesを開いたら、Repository secret `SITE_PASSWORD` と同じ共有パスワードでログインします。
4. 各利用者が初めて生成するときだけ、自分のFine-grained personal access tokenを入力します。
5. tokenは対象リポジトリだけを選び、**Actions: Read and write** と **Contents: Read and write** を付けます。

デプロイ時に `SITE_PASSWORD` から一方向の照合データを生成するため、パスワードの生値はPagesへ配信されません。tokenはサイトパスワードから導出した鍵でAES-GCM暗号化し、各ブラウザのIndexedDBへ保存します。復号したtokenとサイトパスワードはタブの `sessionStorage` だけに保持します。依頼文もAES-GCMで暗号化されてから `.github/workflows/generate-pages.yml` へ送られ、Action内だけで復号されます。画面はqueued / generating / completedをポーリング表示します。

GitHub接続画面から暗号化済み接続ファイルを書き出し、同じ利用者の別端末へ読み込めます。接続ファイルにはtokenの生値は入りませんが、サイトパスワードを知る人は復号できるため安全な方法で受け渡してください。複数利用者で1つのtokenを共有せず、各自のtokenを登録してください。

### 一時画像の扱い

- 参考画像: 非公開のDraft Releaseへ一時アップロードし、Actionの処理後に削除
- 生成画像と結果JSON: 同じDraft Releaseに置き、12時間後に削除
- Cleanup: `.github/workflows/cleanup-pages-results.yml` が毎時実行
- 採用履歴: 各ブラウザのIndexedDBへ3日間保存。画面から個別・一括削除可能
- テンプレート: 各ブラウザのIndexedDBへ15日保存

Pagesのパスワード画面は静的サイト上のクライアント側ゲートです。通常の閲覧者には制作画面を隠しますが、サーバー側認証ではないため、詳しい利用者による回避までは防げません。生成操作にはリポジトリ所有者のGitHub tokenも必要です。UI自体を強固に非公開化する場合は、アクセス制御を持つホスティングが必要です。

## 保存先

- ローカル生成画像: `.runtime/generated/`
- ローカル履歴・テンプレート: ブラウザのIndexedDB
- ローカルAPIキー・サイトパスワード: `.env`
- Pages利用者のGitHub token: 各ブラウザのIndexedDB（AES-GCM暗号化）
- Pages一時画像: GitHub Draft Release（12時間で削除）

`.runtime/`、`.env`、`node_modules/` はGit管理対象外です。

## 構成

```text
.github/workflows/  Pages公開、画像生成、12時間Cleanup
scripts/            Actions用生成・Cleanup処理
src/                ローカルサーバー、認証、OpenAI/GitHub API、プロンプト生成
web/                ローカルとPagesで共用する画面
tokens.css          デザイントークン
```
