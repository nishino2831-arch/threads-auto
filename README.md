# スレッド自動（Threads自動配信）

GitHub Actionsで24時間・Mac非依存にThreadsへ自動投稿する仕組み。

## 構成
- `deliver.mjs` … 配信スクリプト（キャッチアップ方式・二重投稿防止・retry_pending）
- `data/phase1_12.json` … 投稿キュー（Phase1の12投稿）
- `data/phase1_state.json` … 各投稿の状態（posted / retry_pending / draft）
- `data/phase1_delivery_log.csv` … 配信ログ（media_id / permalink）
- `.github/workflows/deliver.yml` … 30分毎の自動実行

## 仕組み
- 30分毎にActionsが起動 → 予定時刻(JST)を過ぎた未投稿を配信
- スリープ/電源OFFのMacに依存しない（GitHubのクラウドで実行）
- 投稿漏れゼロ優先：時刻を過ぎても未投稿なら必ず配信
- 二重投稿防止：状態ファイル＋既存投稿の本文照合

## Secrets（リポジトリ設定に登録済み）
- `THREADS_ACCESS_TOKEN`
- `THREADS_USER_ID`
