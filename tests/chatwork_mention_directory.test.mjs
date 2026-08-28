import assert from "node:assert/strict";
import test from "node:test";
import {
  loadChatworkMentionDirectory,
  resolveChatworkMention
} from "../src/chatwork_mention_directory.mjs";

test("loads API notification names and resolves an exact personal mention", async () => {
  const directory = await loadChatworkMentionDirectory({
    spreadsheetId: "sheet-id",
    sheetName: "API通知",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '"名前","アカウントID","ルームID"\n"山田 太郎","123456","999"'
    })
  });

  assert.equal(directory.ok, true);
  assert.deepEqual(resolveChatworkMention(directory, "山田太郎"), {
    name: "山田 太郎",
    account_id: "123456",
    tag: "[To:123456] 山田 太郎さん"
  });
});

test("does not guess when a name is missing or duplicated across accounts", () => {
  assert.equal(resolveChatworkMention({ entries: [] }, "山田太郎"), null);
  assert.equal(
    resolveChatworkMention(
      {
        entries: [
          { name: "山田太郎", account_id: "1" },
          { name: "山田 太郎", account_id: "2" }
        ]
      },
      "山田太郎"
    ),
    null
  );
});
