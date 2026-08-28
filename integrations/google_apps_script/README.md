# フォーム送信直後にGitHub Actionsを起動する設定

この連携を入れると、10分ごとの確認を待たずに次の順番で処理されます。

```text
Googleフォーム送信
→ 回答シートへ行追加
→ Apps Scriptが追加行番号を取得
→ GitHub Actionsを起動
→ JSONプロンプト作成・画像4枚生成・Chatwork送信
```

10分ごとのGitHub Actionsは、取りこぼし対策として残します。

## 初回設定

1. Googleフォームの回答スプレッドシートを開きます。
2. 「拡張機能」→「Apps Script」を開きます。
3. `Code.gs`へ、このフォルダの[Code.gs](Code.gs)を貼り付けて保存します。
4. Apps Scriptの「プロジェクトの設定」→「スクリプト プロパティ」を開きます。
5. 名前を`GITHUB_ACTIONS_TOKEN`として、GitHubのFine-grained personal access tokenを登録します。
6. トークンには`t-takenoshita/AICR_Factory`だけを対象に、Actionsの書き込み権限を付けます。
7. Apps Scriptの関数一覧から`installAicrFormSubmitTrigger`を選び、1回だけ実行します。
8. Googleの権限確認を許可します。

トークンをコード本文、スプレッドシートのセル、GitHubリポジトリへ書かないでください。

## 動作確認

フォームからテスト回答を1件送信します。GitHubの「Actions」→「Process new AICR requests」に、対象行番号付きの`workflow_dispatch`が追加されれば成功です。

## エラー確認

Apps Script左側の「実行数」で`dispatchAicrOnFormSubmit`の結果を確認できます。GitHub APIが失敗した場合は、HTTPステータスと短いエラー内容が記録されます。
