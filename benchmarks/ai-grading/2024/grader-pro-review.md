# 2024 軽量 Grader Gold review

## 状態

- 作成方法: ChatGPT Pro 内で、公式模範解答、rubric の意味要素、各答案を比較
- 外部 OpenAI API: 不使用
- 公式本文全文: 不使用
- 現在の信頼水準: 一次レビュー（本番利用前に別の人間による確認が必要）

このレビューは、Workers AI に問題そのものを解かせるのではなく、模範解答と採点基準に照らして答案を判定できるかを測るための暫定 Gold label である。機械的な文字列一致ではなく、必須意味とその関係、字数条件を基準にした。

## 2024-1-6

| answerId | Gold | 判定の要点 |
|---|---|---|
| `q1_exact` | correct | 模範解答と同じ意味で40字以内 |
| `q1_paraphrase` | correct | 合理的思考を専門外でも用いるという正しい言い換え |
| `q1_missing_outside` | partial | 合理的思考はあるが、専門領域外へ貫く意味がない |
| `q1_vague_belief` | partial | 領域外へ貫く方向はあるが、合理的思考が欠ける |
| `q1_reversed` | incorrect | 中心関係が模範解答と逆 |
| `q1_keyword_trap` | incorrect | 語句は重なるが、必要な関係を述べていない |
| `q1_irrelevant` | incorrect | 問いの中心意味に答えていない |
| `q1_over_limit` | incorrect | 意味は正しいが40字を超える |

## 2024-2-6

| answerId | 甲 | 乙 | Gold | 判定の要点 |
|---|---|---|---|---|
| `q2_exact` | correct | correct | correct | 模範解答と同じ意味で各10字以内 |
| `q2_paraphrase` | correct | correct | correct | 両欄とも中心意味の正しい言い換え |
| `q2_only_a` | correct | incorrect | partial | 乙が具体的行動だけで、戦争継続をやめる意思に届かない |
| `q2_only_b` | incorrect | correct | partial | 甲が責任を負う認識と逆 |
| `q2_position_trap` | correct | incorrect | partial | 乙が心情変化の中心を表さない |
| `q2_action_trap` | correct | incorrect | partial | 乙が具体的行動だけで、戦争・特攻の中止意思を表さない |
| `q2_reversed` | incorrect | incorrect | incorrect | 両欄とも模範解答と逆 |
| `q2_over_limit` | incorrect | incorrect | incorrect | 両欄とも10字を超える |

## Workers AI 初回実行

- GitHub Actions run: `34764604886`
- 設定: 3モデル、各1回、temperature 0、thinking無効、reasoning effort low
- 入力: 16答案を一括した3,074文字。Gold labelと公式本文全文は除外
- 結果: 3モデルとも推論前に HTTP 429 / Cloudflare error 4006
- 原因: 当日の Workers AI 無料枠10,000 neuronsを既に使い切っていた
- この実行による有効なモデル判定: 0件

無料枠回復後に同じworkflowを再実行する。最初の比較は各モデル1回に留め、Gold一致率が最も高いモデルだけ追加で反復し、再現性を確認する。

## 認証情報修正後の再実行

- GitHub Actions run: `34764725838`（attempt 3）
- 実行日時: 2026-09-14 15:41 JST
- 認証確認: 成功。GitHub Actions の認証情報チェックを3ジョブとも通過
- 結果: 3モデルとも最初の推論要求で HTTP 429 / Cloudflare error 4006
- 有効なモデル判定: 0件

Cloudflare ダッシュボード上では同時点の「Daily usage」が `0/10k` と表示された一方、APIは無料枠消費済みと判定した。直近24時間の表示は合計 `12.91k neurons`（Gemma 4: `1.37k`、Qwen 3.8: `10.09k`、GLM-4.7 Flash: `1.45k`）だった。したがって、今回の失敗は認証情報の欠落や誤ったAccount IDではなく、Cloudflareの無料枠判定とダッシュボード表示の不一致、または使用量リセットの反映待ちとして扱う。

追加課金は行わない。APIが再び利用可能になった時点で、まず各モデル1回の軽量比較を実行する。その結果から最良モデルだけを合計3回まで反復し、全モデルを無条件に3回ずつ実行して無料枠を浪費しない。

## 無料枠回復後の認証済みベンチマーク

- GitHub Actions run: [`34878376170`](https://github.com/FYam8/waseshibu-pages/actions/runs/34878376170)
- 実行日時: 2026-09-15 03:02 JST
- 設定: 16答案を1リクエストに一括、temperature 0、thinking無効
- モデルへ渡した内容: 模範解答、採点観点、字数条件、答案。公式本文全文とGold labelは渡していない

| モデル | Gold一致 | 時間 | 入出力tokens | neurons |
|---|---:|---:|---:|---:|
| Gemma 4 26B | 14/16 (87.5%) | 13.2秒 | 2,453 | 42.90 |
| Qwen 3.8 27B | 14/16 (87.5%) | 49.9秒 | 3,259 | 628.57 |
| GLM-4.7 Flash | 14/16 (87.5%) | 29.2秒 | 2,528 | 46.87 |

3モデルの一致率は同率だった。Gemmaは初回比較で最短・最少neuronsだったため、追加2回だけ実行した。3回とも14/16で、誤差も同じ2答案だった。

| Gemma試行 | Gold一致 | 時間 | tokens | neurons |
|---|---:|---:|---:|---:|
| 1 | 14/16 | 13.2秒 | 2,453 | 42.90 |
| 2 | 14/16 | 12.1秒 | 2,652 | 48.33 |
| 3 | 14/16 | 17.2秒 | 2,490 | 43.91 |

Gemmaの安定した不一致は次の2件で、いずれも暫定Goldの `partial` を `incorrect` と判定した。

- `q1_vague_belief`: 「合理的思考」の明示が弱い境界答案
- `q2_action_trap`: 甲は満たすが乙を満たさない部分点答案

QwenとGLMも不一致は部分点答案を不正解に寄せるケースだった。したがって、現プロンプトは正答・明確な誤答には強い一方、部分点境界で厳しすぎる傾向がある。

### 判断

現時点の第一候補はGemma 4 26Bとする。同率の一致率で、Qwenの約1/15のneurons、GLMより短い応答時間だったためである。ただし、本番投入はまだ行わない。暫定Goldを別の人間が確認し、実際の生徒答案を追加したうえで、特に `partial` の再現率を再評価する必要がある。

今回の有効5リクエスト（3モデル初回＋Gemma追加2回）は合計13,382 tokens、810.58 neuronsだった。Cloudflareの無料枠内で、追加課金は発生していない。

機械可読な集計は `grader-run-34878376170-summary.json` に保存した。各試行の完全な生JSONは同runのGitHub Actions artifactsに保存されている。
