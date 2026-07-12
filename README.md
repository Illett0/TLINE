# TLINE

OuDia/OuDiaSecondのUI・機能コンセプトを参考にした、**運転整理**（列車のダイヤをn秒単位でずらす）と**実績記録**を扱う運行管理補助デスクトップアプリです。

名前は Train + Line（＝「スジ」、ダイヤグラム上の列車の運行線を指す鉄道用語）の言葉遊びで、カタカナ読みは「トライン」。

現在は**プロジェクト骨格の段階**です。設計方針・データモデル・未決事項は[NOTES.md](NOTES.md)を参照してください。

## 想定機能（3タブ構成）

- **計画**: OuDiaのようなダイヤグラム（時刻×駅の折れ線図）で、あらかじめ組んだ運行計画を表示。
- **運転整理**: ある列車を選び、指定した駅から先の時刻をまとめてn秒（正=遅延／負=早着）ずらす。ずらした結果を元のダイヤに重ねて表示。
- **実績**: 実際の着発時刻を入力し、計画との差分（秒）を表示。

## ライセンスについて（重要）

- 本プロジェクトはOuDia/OuDiaSecondの**コードを一切流用せず**、UI・機能コンセプトのみを参考にした独自実装です。OuDia/OuDiaSecondの名称・ロゴも使用しません。
- OuDia本体、および関連ツール（OuDiaParser、clouddia等）はGPL-3.0で公開されています。GPLコードを組み込んだ場合はその成果物全体をGPLで公開する義務が生じ、非商用限定ライセンスとは併用できません。
- `.oud`/`.oud2`ファイルの読み込み対応は必須機能と位置付けていますが、ファイル形式自体（ドット階層+key=value形式のテキスト構造）は事実・仕様であり著作権保護の対象外という理解のもと、**OuDiaParser/clouddiaのソースコードは一切参照せず**、公開されているマニュアル（take-okm氏のOuDia操作マニュアル等）の記述のみを根拠にクリーンルームで独自実装する方針です。判断根拠の詳細は[NOTES.md](NOTES.md)の「ライセンスについて」を参照。
- 上記方針のもと、本プロジェクトは[PathBrowser](https://github.com/Illett0/PathBrowser)と同じ[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)を採用します。非営利目的での利用・改変・再配布は自由ですが、商用利用は許可されていません。詳細は[LICENSE](LICENSE)を参照。

## 現状

- Electron製、素のHTML/CSS/JS（PathBrowserと同じ構成方針）。
- 独自形式（`.tline.json`）でのファイルの開く・保存・名前を付けて保存・最近使ったファイルの再オープンに対応（`scripts/screenshot.js`で実際の画面表示・保存/読み込みの往復を確認済み。NOTES.md参照）。起動直後はサンプルデータ（`data/sampleDiagram.mjs`）を表示。
- `.oud`/`.oud2`インポートは未対応。ドット階層構造・駅一覧・列車番号/方向の抽出はクリーンルーム実装済み（`lib/oudParser.js`）だが、時刻本体(`EkiJikoku`)のエンコードが未解読のため画面には未接続（NOTES.md参照）。
- 列車同士の競合（行き違い・追い越し）チェックは未実装。
- `Diagram/`（`.oud2`実データ、git管理対象外）はTLINEフォルダ直下に配置。詳細はNOTES.md参照。
- GitHub: [Illett0/TLINE](https://github.com/Illett0/TLINE)。ブランチ運用はPathBrowserと同様dev/main併用、現在はdevブランチのみ。

## 起動方法

```bash
npm install
npm start
```

## プロジェクト構成

```
main.js                  Electronメインプロセス（ウィンドウ生成・ファイルI/OのIPCハンドラ）
preload.js                contextBridge経由でwindow.tlineを公開
lib/recentFiles.js        最近使ったファイルのMRUリスト（userData配下に永続化）
lib/oudParser.js          .oud/.oud2のクリーンルームパーサ（時刻本体は未対応、NOTES.md参照）
data/sampleDiagram.mjs    サンプルの計画データ（駅・列車・停車時刻）
renderer/index.html       3タブ+ファイルツールバーの画面
renderer/style.css        スタイル
renderer/app.mjs          画面遷移・状態管理・イベント配線・ファイル操作
renderer/diagramView.mjs  ダイヤグラム（SVG）描画（DOM非依存の純粋関数）
renderer/dispatch.mjs     運転整理（時刻シフト）ロジック（DOM非依存）
renderer/timeUtils.mjs    HH:MM:SS ⇔ 秒数の変換ユーティリティ
scripts/screenshot.js     開発用: Playwrightでアプリを起動し画面表示・ファイル操作を自動検証
```

## ライセンス

[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)。非営利目的での利用・改変・再配布は自由ですが、商用利用は許可されていません。詳細は[LICENSE](LICENSE)を参照してください。
