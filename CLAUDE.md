# CLAUDE.md

このリポジトリで作業する際は、以下を必ず守ること。

## Noout実データの取り扱い（最重要）

`Diagram/Noout/`配下には実在する運行管理データ（駅名・列車番号・時刻など）が入っている。`.gitignore`で除外済みだが、**このリポジトリ（`Illett0/TLINE`）は公開リポジトリ**であることを常に意識すること。

- Nooutの内容を解析目的で読むこと自体は許可されている。分析結果・具体例は**`NOTES.md`（gitignore対象、非公開）にのみ**自由に記録してよい。
- 一方、以下には**実データ（駅名・列車番号・ファイル名・具体的な時刻）を一切書かないこと**:
  - ソースコード（`lib/`・`renderer/`等）のコメント
  - git commitメッセージ
  - GitHub issue・PRの本文・コメント
  - README等、他の公開ドキュメント
- 実例を使って説明する必要がある場合は「駅A」「列車X」のような汎用ラベルに置き換え、「詳細はNOTES.md参照」と書く。
- 高根鉄道系ファイル（`Diagram/高根鉄道*.oud2`など、Noout外）は実データではない（作成者が別で、Nooutのような機密性の指摘は無い）ため、この制限の対象外。

過去に一度、コード内コメントとissueコメントに大量のNoout実データが露出し、事後に手作業で修正する事態が発生している（2026-08-08、commit 6a6cd34/ed0ef1d）。**新しくコード・commit・issueを書く前に、Noout由来の固有情報が入っていないか必ず見直すこと。**

## リリース手順

`dev`→`main`のマージ・タグ付け・GitHub Release作成の手順は`NOTES.md`「リリース時の手順」参照（`--no-ff`マージが必須）。

## 作業環境（PC 2台）

- ノートPCとデスクトップの2台で作業する。リポジトリはどちらも`C:\dev\TLINE`（OneDriveの外。node_modulesを同期させないため、2026-10-15に移した）。
- `NOTES.md`・`Diagram/`・`.tmp-screenshots/`（gitignore対象）の実体はOneDriveの`Claude\_dev-local\TLINE\`にあり、ここからリンクしている。2台で同じ`NOTES.md`を編集することになるので、両方で同時に書き換えない（OneDriveが競合コピーを作る）。リンクは`.git/info/exclude`でgitから外してある。
- PCを切り替えるときは、終えるPCでcommitとpush、始めるPCで`git pull`。未pushの作業はもう一方に届かない。
- 作り直しや新しいPCでは、OneDriveの`Claude\_dev-local\setup-dev.ps1`を実行する（clone、リンク、`npm ci`、`npm run setup`、Electron本体の取得、起動確認まで）。
- 2台のClaude Codeのやり取りは`Claude\_dev-local\HANDOFF.md`（連絡帳）。
