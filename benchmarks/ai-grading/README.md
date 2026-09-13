# 国語 AI採点ベンチマーク

目的: 早稲田渋谷シンガポール校の実際の国語過去問・公式模範解答を基準に、Workers AI の「問題を解く能力」と「答案を採点する能力」を分けて検証する。

## 安全方針

- 本番アプリの問題ID・学習履歴・公開データは変更しない。
- この `benchmarks/ai-grading/` 配下だけで検証する。
- Solver テストでは公式模範解答をモデルに見せない。
- Grader テストでは公式模範解答と人間確認済みrubricをモデルに見せる。
- プロンプト改善に使う問題と、最終テスト問題は将来分離する。

## 現在の2024年度 seed

### 2024-1-6
- 形式: 自由記述
- 配点: 10点
- 字数: 40字以内
- 用途: AI自由記述能力の主テスト

### 2024-2-6
- 形式: 短答記述2欄
- 配点: 甲5点 + 乙5点
- 字数: 各10字以内
- 用途: 心情変化・短答の意味判定テスト

公式資料URLと模範解答は `2024/questions.json` に保存。Solver入力は `2024/solver-cases.json` に分離し、公式解答を含めない。

## Workers AI 実行

既定モデル:

`@cf/google/gemma-4-26b-a4b-it`

環境変数:

```bash
export CLOUDFLARE_ACCOUNT_ID='...'
export CLOUDFLARE_AUTH_TOKEN='...'
```

実行:

```bash
node benchmarks/ai-grading/run-workers-ai.mjs
```

同一答案を3回実行し、`benchmarks/ai-grading/results/` にJSONを保存する。

別モデル比較:

```bash
WORKERS_AI_MODEL='@cf/zai-org/glm-4.7-flash' node benchmarks/ai-grading/run-workers-ai.mjs
```

## 初期評価項目

各実行について以下を確認する。

1. 字数条件を守ったか
2. 公式解答と意味が一致するか
3. 本文にない内容を足していないか
4. 必須の意味要素を落としていないか
5. 同一問題3回で結論が安定するか

最終的な採点AI評価では、言い換え正答、部分正答、キーワードだけ似た誤答、本文と矛盾する誤答、問いに答えていない答案などを追加する。

## 次の工程

1. Gemma 4 26B A4B で2024年2問を3回ずつ実行
2. 公式解答と比較して問題理解能力を判定
3. 問題がなければ採点者用のrubric/test answersを作成
4. 2025・2026へ拡張
5. 最終的に2019〜2026を検証
