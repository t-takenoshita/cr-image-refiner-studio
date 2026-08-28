# CR Image Refiner

記事用クリエイティブと自由入力の画像を、OpenAI Image APIで生成するローカルWebアプリです。

## 主な機能

- 記事画像制作: 依頼入力 → AI要件化 → 4案生成 → 確認 → 採用・修正
- フリー画像生成
- 生成履歴とテンプレートのブラウザ保存
- 共通パスワードによるアクセス制限
- 生成画像のローカル保存

Google Forms、Google Sheets、Google Drive、Chatwork、GitHub Actionsには接続しません。

## セットアップ

Node.js 20以上が必要です。

```bash
cp .env.example .env
npm install
```

`.env`に次の2項目を設定します。

```dotenv
OPENAI_API_KEY=sk-...
SITE_PASSWORD=十分に長いパスワード
```

起動:

```bash
npm run dev
```

[http://localhost:3000/studio](http://localhost:3000/studio) を開き、`SITE_PASSWORD`でログインします。停止は起動したターミナルで `Ctrl+C` です。

## 保存先

- 生成画像: `.runtime/generated/`
- 履歴・テンプレート: ブラウザのLocal Storage
- APIキー・サイトパスワード: `.env`

`.runtime/`と`.env`はGit管理の対象外です。履歴とテンプレートはブラウザ単位で保存され、テンプレートはアプリの仕様に従って15日で期限切れになります。

## 構成

```text
src/       Webサーバー、認証、画像API、プロンプト生成
web/       画面
tokens.css デザイントークン
```
