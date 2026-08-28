const GITHUB_OWNER = "t-takenoshita";
const GITHUB_REPO = "AICR_Factory";
const GITHUB_WORKFLOW = "process-new-requests.yml";
const GITHUB_REF = "main";

/**
 * Googleフォーム回答シートの「フォーム送信時」インストール型トリガーから呼び出します。
 * GitHubトークンはスクリプトプロパティ GITHUB_ACTIONS_TOKEN に保存してください。
 */
function dispatchAicrOnFormSubmit(event) {
  if (!event || !event.range) {
    throw new Error("フォーム送信イベントから実行してください。");
  }

  const rowNumber = event.range.getRow();
  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    throw new Error(`不正な回答行です: ${rowNumber}`);
  }

  const token = PropertiesService.getScriptProperties().getProperty("GITHUB_ACTIONS_TOKEN");
  if (!token) {
    throw new Error("スクリプトプロパティ GITHUB_ACTIONS_TOKEN が未設定です。");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const response = UrlFetchApp.fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
      {
        method: "post",
        contentType: "application/json",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        payload: JSON.stringify({
          ref: GITHUB_REF,
          inputs: { row_number: String(rowNumber) }
        }),
        muteHttpExceptions: true
      }
    );

    const status = response.getResponseCode();
    if (status !== 204) {
      throw new Error(`GitHub Actions起動失敗 HTTP ${status}: ${response.getContentText().slice(0, 300)}`);
    }

    console.log(`AICR Factoryを起動しました。row_number=${rowNumber}`);
  } finally {
    lock.releaseLock();
  }
}

/** 初回設定時に1回だけ手動実行します。重複トリガーは削除して作り直します。 */
function installAicrFormSubmitTrigger() {
  const handler = "dispatchAicrOnFormSubmit";
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === handler)
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger(handler)
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onFormSubmit()
    .create();

  console.log("AICR Factoryのフォーム送信トリガーを登録しました。");
}
