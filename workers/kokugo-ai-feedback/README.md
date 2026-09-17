# 国語AIフィードバック公開パイロット

2022～2026年度の代表5問について、公式模範解答と短い判定観点を使い、Gemma 4 26Bが答案を一度だけ判定するCloudflare Workerである。既存アプリの学習履歴は読み書きしない。

公開先: <https://waseshibu-kokugo-ai-feedback.fyam8.workers.dev>

## 安全・費用設計

- 問題本文全文はAIへ送らない。
- 1リクエストにつき答案1件、推論1回だけ行う。自動再試行はしない。
- 答案は400字、HTTP本文は8KBまで。
- 1IP相当につきUTC日ごとに3回、全体で25回まで。
- 日別Durable Objectが推論前に枠を予約し、多数の接続元があっても全体上限を超えない。
- 出力は最大700 tokens、temperature 0、thinking無効。
- AIの点数は公式採点ではなく、学習上の参考値として表示する。

初回ベンチマークでは15答案一括で150.9 Neuronsだった。単純平均は約10.1 Neurons/答案なので、25回上限の目安は約252 Neurons/日、無料枠10,000 Neurons/日の約2.5%である。

2026-09-17の公開後テストでは、模範解答相当の答案1件を12/12・correctと判定し、入力・出力合計728 tokens、9.6364 Neuronsを使用した。これは無料枠10,000 Neurons/日の約0.096%である。同程度の使用量で25回すべて使った場合は約240.9 Neurons、無料枠の約2.41%となる。応答後の予約枠は24/25で、推論が1回だけ行われたことも確認した。

デプロイはGitHub Actions run [35147914696](https://github.com/FYam8/waseshibu-pages/actions/runs/35147914696) で成功した。公開確認後は意図しない再デプロイを避けるため、デプロイWorkflowを手動実行専用に戻している。

## 確認

```bash
pnpm install
pnpm test
pnpm run types
pnpm run check
```

## API

- `GET /` 公開テスト画面
- `GET /health` 稼働確認
- `GET /v1/questions` 公開可能な設問情報
- `GET /v1/usage` 当日の保護枠（請求上のNeuronsとは別）
- `POST /v1/grade` `{ "questionId": "2024-2-6", "answer": { "甲": "...", "乙": "..." } }`

