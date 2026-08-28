# CR Image Refiner

記事部・マーケター向けのWeb完結型画像制作スタジオです。Google Forms、Google Sheets、Chatwork、GitHub Actionsには接続せず、ブラウザから依頼入力、4案生成、確認、採用・修正まで進めます。

## Webアプリを開く

```bash
npm install
cp .env.example .env
# .env の OPENAI_API_KEY と SITE_PASSWORD を実際の値へ置き換える
npm run dev
```

ブラウザで `http://localhost:3000/studio` を開きます。`gpt-image-2` のAPIキーはプロジェクト直下の `.env` に `OPENAI_API_KEY=...` として設定します。サイトの共有パスワードは同じファイルに `SITE_PASSWORD=...` として設定します。`.env` はGit管理対象外で、どちらの値もブラウザへ保存しません。変更後はサーバーを再起動してください。

主な画面:

- 記事画像制作: 依頼入力 → AI要件化 → 認識確認 → 4案生成 → 記事部確認 → 採用・修正
- フリー画像生成: 記事案件に紐づかない自由生成
- 生成履歴: 採用画像をブラウザ内に保存
- テンプレート: 15日保存、延長・削除・再利用

## 流用したAICRロジック

4案のプロンプト設計とOpenAI画像生成部分をAICR Factoryから流用しています。以下の旧運用ドキュメントとCLIは参考・互換用に残していますが、Webアプリの通常利用では外部フォームやChatwork処理は実行されません。

---

## AICR Factory由来のCLI資料

普段の運用だけ確認したい場合は、[かんたん取説](docs/かんたん取説.md)を参照してください。

AICR Factoryは、Googleフォーム由来のAICR依頼を1件ずつ処理し、Image2用のAIバナー案を作る制作オペレーション用プロジェクトです。

Codex本体は学習母艦/RAG/PDCA、このプロジェクトは制作ラインです。生成結果やFBは勝ち学習へ自動登録しません。採用/非採用/成果が明確なものだけ、将来Codexへ学習候補として戻せる前提でmanifestに境界を残します。

## 現在の到達点

- fixture 1件を依頼キューの1行として読み取る
- `request_id` を生成する
- 1依頼からImage2用prompt 4案を作る
- 各案に `variant_id` / `prompt` / `generation_tags` / `policy_gate_result` を残す
- 画像CR共通のデザイン指示として、LPファーストビュー、余白、視線導線、文字ジャンプ率、オファー、世界観、NGデザインをpromptへ入れる
- `prompt_pack.json` / `manifest.json` / `sheet_update_preview.json` をローカル出力する
- 初稿だけを対象に、未処理行から4枚生成してChatworkへ投稿するrunnerを用意する
- Chatwork FBはパースできるが、修正版の自動再生成はしない
- デフォルトでは外部送信、画像生成、Drive保存、Chatwork投稿、Sheet書き戻しを行わない

## ディレクトリ

```text
/Users/miyekeyuta/Documents/AICR_Factory/
  config/
  fixtures/
  src/
  tools/

/Users/miyekeyuta/Documents/AICR_Factory_data/
  outputs/requests/{request_id}/
  logs/
  cache/locks/
```

## 基本コマンド

```bash
npm run google:preflight
npm run queue:list
npm run queue:google:list
npm run queue:google:dry-run
npm run queue:next:dry-run
npm run queue:dry-run
npm run initial:draft:dry-run
npm run sheet:inspect:dry-run
npm run queue:csv:dry-run
npm run revision:dry-run
```

`npm run queue:dry-run` は、`fixtures/google_form_row.json` を1件処理し、以下を作ります。

```text
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/prompt_pack.json
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/manifest.json
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/sheet_update_preview.json
```

`npm run sheet:inspect:dry-run` は、`config/sources.example.json` のGoogleフォーム回答シートを読み取り、ヘッダーと管理列の不足を確認します。公開CSVとして読めない場合は、書き込みや認証操作を行わず、`auth_required_or_not_public` として以下に記録します。

```text
/Users/miyekeyuta/Documents/AICR_Factory_data/cache/sheet_inspection.json
```

`npm run queue:csv:dry-run` は、Google Sheetsから手動エクスポートしたCSVと同じ形のfixtureを1件処理します。実シートの再認証前でも、列構造と制作ラインのdry-run検証ができます。

## トリガー方針

初期運用のトリガーは、**初稿だけ半自動**にします。

理由:

- 医療/美容/BA表現のpolicy gateを人間が見たい
- 初稿は依頼内容をそのまま制作するため自動化しやすい
- FB修正は「画像2は画像1のこと」のような解釈が入るため自動再生成しない
- 成果不明の案件を勝ち学習へ混ぜないため、FBと採用状況を分けて扱いたい
- Sheetコネクタや書き戻しが安定するまでは、二重処理をローカルmanifestで止めるほうが安全

現時点の推奨フロー:

```bash
npm run initial:draft:dry-run
```

`initial:draft:dry-run` は、Googleフォーム回答シートを公開CSVとして読み、新規未処理行だけを見ます。既に `prompt_pack.json` / `manifest.json` / `delivery_result.json` がある依頼は除外します。

通常コマンドは `--after-last-posted-row` により、最後にChatwork投稿済みの行を自動判定します。
今後は、その後に追加された新規依頼だけを順番に処理し、過去の未処理行へは戻りません。
`--row-number` を明示した手動実行では、任意の対象行を固定できます。

現在の通常運用は `--disable-policy-gate` を指定しているため、リポジトリ独自の
ポリシー検知・警告・自動停止を行いません。OpenAI API側の安全判定は引き続き適用されます。

初稿を実生成してChatworkへ投稿するrunner:

```bash
npm run initial:draft:execute
```

このコマンドは以下が揃うまで失敗します。

- `--execute`
- `--send-chatwork`
- `guardrails.initial_draft_auto_enabled=true`
- `guardrails.image2_generation_enabled=true`
- `guardrails.initial_draft_chatwork_send_enabled=true`
- `guardrails.chatwork_send_enabled=true`
- `OPENAI_API_KEY`
- `CHATWORK_API_TOKEN`

Drive保存とGoogle Sheets書き戻しは、このrunnerでは実行しません。

失敗済みの特定依頼だけを再試行する場合は、古い失敗行を誤選定しないように `--request-id` か `--row-number` で対象を固定します。

```bash
node tools/run_initial_draft.mjs \
  --source public-csv \
  --only-new \
  --include-prompted \
  --retry-failed \
  --request-id aicr_YYYYMMDD_xxxxxxxxxx \
  --limit 1 \
  --execute \
  --send-chatwork \
  --guardrails /path/to/local.guardrails.json \
  --openai-env-file /path/to/openai.env \
  --chatwork-env-file /path/to/chatwork.env
```

段階的な自動化案は `config/trigger.example.json` に残しています。

| 段階 | トリガー | 実行内容 |
| --- | --- | --- |
| Phase 1 | 初稿runner | 未処理1件をprompt pack化。許可時だけ4枚生成してChatwork投稿 |
| Phase 2 | ローカル定期実行 | 新規依頼だけ初稿runnerを定期実行 |
| Phase 3 | Sheet status queue | `status` / `locked_at` / `locked_by` で共有キュー化 |

今はPhase 1を標準にします。

## status定義

| status | 意味 |
| --- | --- |
| `new` | 未処理の新規依頼 |
| `generating` | 生成処理中 |
| `generated` | 画像生成済み |
| `posted` | Chatwork投稿済み |
| `needs_revision` | 修正依頼あり |
| `done` | 完了 |
| `error` | 処理失敗 |
| `policy_hold` | policy gateで人間確認が必要 |

## 画像CRプロンプト設計

Image2 promptは、フォーム原文を保持したまま、画像CRとしての見やすさと行動喚起を強める共通レイヤーを入れます。

初稿テンプレートは `config/prompt_templates/banner_variants.json` で管理します。現在は4案固定で、配色は `src/prompt_builder.mjs` の curated な配色プールから案ごとに選びます。完全な自由ランダムではなく、蛍光色、虹色、多色使い、原色同士の衝突、読みにくい低コントラストが起きにくい組み合わせだけを候補にします。依頼IDベースでシャッフルするため、依頼ごとに配色は変わりますが、同じ依頼をdry-runし直しても同じ4配色になります。

例:

```text
希望テイスト: 清潔感、信頼感、スマホで見やすい

画像1: オファー大見出し型 × 配色プールから選定
画像2: 悩み共感型 × 配色プールから選定
画像3: 比較/チェックリスト型 × 配色プールから選定
画像4: 主ビジュアル+オファーパネル型 × 配色プールから選定
```

各variantには `appeal_variant` / `color_palette_id` / `color_palette_name` / `color_policy` / `composition` / `color` / `copy_type` を `generation_tags` として残します。30枚以上必要な依頼では、4枚ずつ追加生成し、配色プールを広げながらデザイン偏りを減らす運用を想定します。

共通で入れる観点:

- プロの広告デザイナーとして作る
- LPのファーストビューのように、世界観・訴求・オファーが一目で伝わる構成にする
- 適度な余白、視線導線、文字のジャンプ率、メリハリを強める
- ダイナミックな躍動感と、遊びのあるグラフィック要素/テキスト処理を入れる
- 誘導文を入れる場合は短いオファー/ベネフィット表示に留め、予約から施術までの流れや3STEPなどの手順説明にしない
- 簡単3STEP、予約、相談、来院、施術など、今後何をするかを伝える情報は画像CRに入れない
- 過度なあしらい、過度な文章、情報過多、装飾過多は避ける

このレイヤーは広告審査・倫理判断による書き換えではなく、制作品質を上げるためのデザイン指示です。policy gateは引き続き検知とラベル付けだけを行い、フォーム原文の削除・言い換えはしません。

## 管理列

シートには以下の管理列を追加する前提です。

```text
request_id
status
priority
locked_at
locked_by
generated_at
drive_folder_url
image_1_url
image_2_url
image_3_url
image_4_url
chatwork_message_id
error_message
retry_count
revision_count
adoption_status
feedback
```

現時点のSheet管理列は初期運用の4URL列に合わせています。追加で30枚以上作る場合は、4枚ずつ別依頼または追加生成として扱い、配色プールから毎回異なる組み合わせを出して管理します。

対象シート:
https://docs.google.com/spreadsheets/d/1_C66pvuPhjD-ZAsMjniyW117R6MRkxOyNVylMGk3tEE/edit?gid=55285306#gid=55285306

## dry-runと本番実行の違い

デフォルトは必ずdry-runです。

| 操作 | dry-run | 本番側の条件 |
| --- | --- | --- |
| Image2生成 | prompt packのみ作成 | `--generate-images` と `guardrails.image2_generation_enabled=true` |
| 初稿runner | planのみ作成 | `--execute` と `guardrails.initial_draft_auto_enabled=true` と `guardrails.image2_generation_enabled=true` |
| Drive保存 | ローカル保存のみ | `--upload-drive` と `guardrails.drive_upload_enabled=true` |
| Chatwork投稿 | 投稿payloadを作るだけ | `--send` と `guardrails.chatwork_send_enabled=true` と `--confirm-human-reviewed` |
| 初稿Chatwork投稿 | payloadのみ作成 | `--send-chatwork` と `guardrails.initial_draft_chatwork_send_enabled=true` と `guardrails.chatwork_send_enabled=true` |
| Sheet書き戻し | 差分previewのみ | `--write-sheet` と `guardrails.sheet_write_enabled=true` と `--confirm-human-reviewed` |

現マイルストーンでは、初稿生成だけOpenAI Images APIアダプタを接続しています。Drive書き込み・Sheet実書き込みは未接続です。FB修正の再生成は自動化しません。

## 初稿自動runner

初稿runner:

```bash
npm run initial:draft:dry-run
```

実行内容:

1. Googleフォーム回答シートを読む
2. 未処理の `new` 行だけ選ぶ
3. 1件だけ `prompt_pack.json` / `manifest.json` / `initial_draft_plan.json` を作る
4. dry-runでは画像生成・Chatwork投稿をしない

実生成とChatwork投稿を許可する場合は、ローカル用guardrailsを作り、必要な値だけtrueにします。

初稿4案は `initial_draft.image_generation_concurrency` の数だけ並列生成します。
標準値は `2` で、API負荷を抑えながら生成待ち時間を短縮します。

```json
{
  "initial_draft_auto_enabled": true,
  "initial_draft_chatwork_send_enabled": true,
  "image2_generation_enabled": true,
  "chatwork_send_enabled": true,
  "initial_draft": { "image_generation_concurrency": 2 },
  "revision_auto_generation_enabled": false,
  "chatwork_feedback_auto_regenerate_enabled": false
}
```

雛形:

```text
/Users/miyekeyuta/Documents/AICR_Factory/config/guardrails.initial_draft.example.json
```

環境変数:

```bash
OPENAI_API_KEY=...
CHATWORK_API_TOKEN=...
```

トークン値はチャットやREADMEへ貼らず、ローカルenvファイルかシェル環境だけに置きます。

このリポジトリ構成では、Chatworkの秘密情報を親ディレクトリの
`../secrets/chatwork.env` に置きます。

```env
CHATWORK_API_TOKEN=...
CHATWORK_ROOM_ID=442334168
```

投稿せずに接続だけ確認する場合:

```bash
npm run chatwork:check
```

`テスト` と1件だけ投稿する場合:

```bash
npm run chatwork:test:send
```

実行:

```bash
node tools/run_initial_draft.mjs \
  --source public-csv \
  --only-new \
  --include-prompted \
  --limit 1 \
  --execute \
  --send-chatwork \
  --guardrails /path/to/local.guardrails.json \
  --openai-env-file /path/to/openai.env \
  --chatwork-env-file /path/to/chatwork.env
```

出力:

```text
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/prompt_pack.json
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/manifest.json
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/initial_draft_plan.json
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/generation_result.json
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/delivery_result.json
```

## 案件マスタとブランド資産

案件ごとのロゴ、必須注釈、NG表現、ブランドカラーは案件マスタから読みます。デフォルトではOFFです。ONにした場合も、dry-runでは画像生成やChatwork投稿を行わず、適用結果だけを `prompt_pack.json` / `manifest.json` / `initial_draft_plan.json` に残します。

案件マスタの列:

```text
案件ID
案件名
ロゴ画像の参照(DriveファイルIDまたはURL)
必須注釈の文言
NG表現(カンマ区切り)
ブランドカラー(HEX)
備考
```

設定雛形:

```text
/Users/miyekeyuta/Documents/AICR_Factory/config/client_master.example.json
```

ローカル確認用のguardrails例:

```json
{
  "client_master": {
    "enabled": true,
    "config_path": "config/client_master.example.json",
    "read_mode": "public-csv-or-google-sheets"
  },
  "brand_assets": {
    "logo_insertion_enabled": true,
    "required_note_band_enabled": true,
    "brand_color_prompt_enabled": false,
    "logo_avoid_note_band_enabled": true,
    "bottom_safe_area_prompt_enabled": true,
    "default_logo_placement": "bottom_right",
    "logo_overlay": {
      "max_width_ratio": 0.18,
      "max_height_ratio": 0.1,
      "margin": 32
    },
    "note_band": {
      "use_brand_color_as_background": true,
      "background_color": "#111111",
      "text_color": ""
    }
  }
}
```

dry-run確認:

```bash
node tools/run_initial_draft.mjs \
  --csv /path/to/form_rows.csv \
  --client-master-csv /path/to/client_master.csv \
  --data-root /tmp/aicr-master-check \
  --only-new \
  --limit 1 \
  --guardrails /path/to/local.guardrails.json
```

確認するJSON:

```text
/tmp/aicr-master-check/outputs/requests/{request_id}/initial_draft_plan.json
/tmp/aicr-master-check/outputs/requests/{request_id}/manifest.json
/tmp/aicr-master-check/outputs/requests/{request_id}/prompt_pack.json
```

確認ポイント:

- `client_master.matched` が `true` なら案件マスタが適用されています。
- 未登録案件は `client_master.matched=false` になり、`manifest.client_master.warnings` と `request.validation.warnings` に警告が残ります。
- ロゴが有効な場合、execute時だけロゴ参照を取得し、OpenAI Images edit endpointへ入力画像として渡します。dry-runでは参照と計画だけを残します。
- `bottom_safe_area_prompt_enabled=true` かつ必須注釈がある場合、注釈帯の見積もり高さから下部セーフエリア%を算出し、各variant promptへ入れます。
- 必須注釈はプロンプトへ入れず、生成後にsharpで下部帯として合成します。`generation_result.json` の `postprocess.required_note_band.text` がマスタ文言と同一であることを確認します。
- `logo_avoid_note_band_enabled=true` かつロゴ/注釈帯が両方有効な場合、処理順は `リサイズ -> 文字品質ゲート -> 注釈帯overlay -> ロゴoverlay` です。ロゴは最後に注釈帯の外側へ合成され、`postprocess.logo_overlay.fully_outside_note_band=true` で確認できます。
- 画像の最終パスは従来どおり `final_local_path` です。注釈帯適用後も `1080x1080` などの最終規格を維持します。

初稿runnerの範囲外:

- Driveアップロード
- Google Sheets書き戻し
- Chatwork FBの自動再生成
- 勝ち学習への自動登録

## Google Sheets API連携

設定ファイル:

```text
/Users/miyekeyuta/Documents/AICR_Factory/config/google_sheets.example.json
/Users/miyekeyuta/Documents/AICR_Factory/config/sources.example.json
```

`config/google_sheets.example.json` は、Google Sheets API + サービスアカウントでフォーム回答シートを読むための設定です。CSVを毎回ダウンロードしない運用はこちらを使います。

人間がやる初期設定:

1. Google CloudでAICR用プロジェクトを作る
2. Google Sheets APIを有効化する
3. サービスアカウントを作る
4. JSONキーを以下に保存する

```text
/Users/miyekeyuta/Documents/AICR_Factory_data/secrets/google-service-account.json
```

5. フォーム回答スプレッドシートをサービスアカウントのメールアドレスに共有する

最初は閲覧者で十分です。Sheet書き戻しを有効にする段階で編集者へ変えます。

認証情報ファイルの中身は表示・共有・コミットしません。`config/google_sheets.example.json` の `service_account_key_file` か、環境変数 `AICR_GOOGLE_SERVICE_ACCOUNT_KEY_FILE` でパスだけを指定します。

接続確認:

```bash
npm run google:preflight
```

成功すると以下に接続結果だけを保存します。秘密鍵やtokenは保存しません。

```text
/Users/miyekeyuta/Documents/AICR_Factory_data/cache/google_sheets_preflight.json
```

新規行の確認:

```bash
npm run queue:google:list
```

未処理1件をdry-run処理:

```bash
npm run queue:google:dry-run
```

このコマンドはGoogle Sheetsを読みますが、デフォルトでは以下を行いません。

- Image2生成
- Drive保存
- Chatwork投稿
- Google Sheets書き戻し

未処理判定は、Google Sheetsの行から生成した `request_id` と、ローカルの `prompt_pack.json` / `manifest.json` / `delivery_result.json` の有無で行います。`--only-new` により、既に処理済みの行を飛ばします。

## 公開CSV/手動CSV読み取り

`config/sources.example.json` は、公開CSVまたは手動CSVでフォーム回答シートを検査するための設定です。Google Sheets API連携が未設定のときのfallbackとして使います。

dry-run inspect:

```bash
npm run sheet:inspect:dry-run
```

現在の読み取り順序は以下です。

1. シートURLから `spreadsheet_id` と `gid` を解析する
2. `A1:AZ2` のような狭いヘッダー範囲だけを対象にする
3. 公開CSVとして読める場合だけヘッダーと2行目サンプルを取得する
4. サンプル値はデフォルトで `[redacted]` にする
5. 公開CSVで読めない場合は `auth_required_or_not_public` として止める

Google Sheets API連携が使える場合は、`npm run google:preflight` と `npm run queue:google:dry-run` を優先します。書き込みは別工程で、`--write-sheet` とguardrails許可と人間確認が揃うまで実行しません。

手動CSVで1件を通す場合:

```bash
node tools/run_queue.mjs --dry-run --csv path/to/exported_google_form_rows.csv --limit 1
```

## Chatwork FBからの修正

初期運用では、Chatwork返信の完全自動再生成はしません。Chatwork上のFBは読み取り・パースできますが、曖昧な紐づけがある場合は人間確認で止めます。

修正ループの原則:

- Chatwork上の画像番号とFB本文を必ず紐づける
- 1回のFBで再生成するのは原則1画像
- `revision_prompt.json` をdry-runで確認してからImage2/imagegenを実行する
- 元promptは保持し、FBで指定された差分だけを反映する
- policy gateは検知とラベル付けだけ。FBにない安全寄せ・削除・言い換えはしない
- 再生成後はChatworkに「修正版: 画像N / revision rX」として追加投稿する
- 自動で修正版画像を生成しない

ChatworkからFBを読む:

```bash
npm run feedback:chatwork:parse -- \
  --request-id aicr_YYYYMMDD_xxxxxxxxxx \
  --room-id 442334168 \
  --env-file /path/to/chatwork.env
```

パース結果:

```text
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/feedback/parsed_feedback_latest.json
```

推奨FB形式:

```text
修正 request: dd6e98770a
画像: 1
FB: 無料訴求が強すぎるので自然見え寄せ。BA感も少し弱める
```

もっと雑な書き方でも、画像番号はある程度拾えます。

```text
画像①、無料訴求強すぎ。自然見え寄せで再生成して
3案目の文字が小さいので読みやすく
variant_4、CTAもっと強め
```

dry-run:

```bash
node tools/revise_from_feedback.mjs \
  --dry-run \
  --request-id aicr_20260612_dd6e98770a \
  --variant 1 \
  --feedback "画像①、無料訴求が強すぎるので自然見え寄せ。BA感も少し弱める"
```

出力:

```text
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/revisions/r{n}_variant_{variant}/revision_prompt.json
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/revisions/r{n}_variant_{variant}/chatwork_reply_dry_run.json
/Users/miyekeyuta/Documents/AICR_Factory_data/outputs/requests/{request_id}/revision_history.json
```

`revision_prompt.json` の `revised_prompt` を使って、該当画像だけImage2/imagegenで再生成します。再生成後にChatworkへ投稿する場合も、まず `chatwork_reply_dry_run.json` を確認してから送ります。

## policy gate

各variantのpromptに対して、以下を確認します。

- NG表現
- 医療/美容リスク
- BA表現リスク
- 誇大表現
- before/after過剰表現
- 医療効果の断定

policy gateは **検知とラベル付けだけ** を行います。

- フォーム原文を自動で削除しない
- フォーム原文を自動で言い換えない
- 広告審査・倫理・医療美容リスクを理由に、AI側判断でpromptから落とさない
- `prompt_contract.ai_rewrite_performed=false` を残す
- `prompt_contract.ai_safety_omission_performed=false` を残す
- 表現変更は、人間が明示的に「この表現へ変える」と指示した時だけ行う

`hold` が出た場合、初期運用では人間確認が必要です。policy gate自体はpromptを書き換えません。

## lock設計

dry-runでは `AICR_Factory_data/cache/locks/{request_id}.lock.json` を処理中だけ作るatomic local lockで二重処理を防ぎます。実シートキューでは同じ考え方を `locked_at` / `locked_by` / `status` に反映する前提です。

## エラー時

失敗時も以下を残します。

- `manifest.json` の `error`
- `sheet_update_preview.json` の `error_message`
- `retry_count` の増分preview
- `AICR_Factory_data/logs/YYYY-MM-DD.jsonl`

認証情報、APIキー、OAuthトークン、Cookieは表示・保存・共有しません。
