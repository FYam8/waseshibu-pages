# 国語AIフィードバック公開パイロット

2022～2026年度の代表5問について、公式模範解答と短い判定観点を使い、Gemma 4 26Bが答案を一度だけ判定するCloudflare Workerである。既存アプリの学習履歴は読み書きしない。

## 安全・費用設計

- 問題本文全文はAIへ送らない。
- 1リクエストにつき答案1件、推論1回だけ行う。自動再試行はしない。
- 答案は400字、HTTP本文は8KBまで。
- 1IP相当につきUTC日ごとに3回、全体で25回まで。
- 日別Durable Objectが推論前に枠を予約し、多数の接続元があっても全体上限を超えない。
- 出力は最大700 tokens、temperature 0、thinking無効。
- AIの点数は公式採点ではなく、学習上の参考値として表示する。

初回ベンチマークでは15答案一括で150.9 Neuronsだった。単純平均は約10.1 Neurons/答案なので、25回上限の目安は約252 Neurons/日、無料枠10,000 Neurons/日の約2.5%である。実際の使用量はモデル出力により変動するため、公開後の実リクエストでも確認する。

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
