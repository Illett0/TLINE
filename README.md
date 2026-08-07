# TLINE

OuDia/OuDiaSecondのUI・機能コンセプトを参考にした、**運転整理**（列車のダイヤをn秒単位でずらす）と**実績記録**を扱う運行管理補助デスクトップアプリです。

名前は Train + Line（＝「スジ」、ダイヤグラム上の列車の運行線を指す鉄道用語）の言葉遊びで、カタカナ読みは「トライン」。

現在は**プロジェクト骨格の段階**です。未実装・今後の展望は[GitHub Issues](https://github.com/Illett0/TLINE/issues)で管理しています。

## 想定機能（3タブ構成）

- **計画**: OuDiaのようなダイヤグラム（時刻×駅の折れ線図）で、あらかじめ組んだ運行計画を表示。
- **運転整理**: ある列車を選び、指定した駅から先の時刻をまとめてn秒（正=遅延／負=早着）ずらす。ずらした結果を元のダイヤに重ねて表示。
- **実績**: 実際の着発時刻を入力し、計画との差分（秒）を表示。

## ライセンスについて（重要）

- 本プロジェクトはOuDia/OuDiaSecondの**コードを一切流用せず**、UI・機能コンセプトのみを参考にした独自実装です。OuDia/OuDiaSecondの名称・ロゴも使用しません。
- OuDia本体、および関連ツール（OuDiaParser、clouddia等）はGPL-3.0で公開されています。GPLコードを組み込んだ場合はその成果物全体をGPLで公開する義務が生じ、非商用限定ライセンスとは併用できません。
- `.oud`/`.oud2`ファイルの読み込み対応は必須機能と位置付けていますが、ファイル形式自体（ドット階層+key=value形式のテキスト構造）は事実・仕様であり著作権保護の対象外という理解のもと、**OuDiaParser/clouddiaのソースコードは一切参照せず**、OuDiaSecond公式が公開しているファイル形式変更点の記事群など、GPLコードそのものではない一次情報の記述のみを根拠にクリーンルームで独自実装する方針です（進捗は[issue #1](https://github.com/Illett0/TLINE/issues/1)参照）。
- 上記方針のもと、本プロジェクトは[PathBrowser](https://github.com/Illett0/PathBrowser)と同じ[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)を採用します。非営利目的での利用・改変・再配布は自由ですが、商用利用は許可されていません。詳細は[LICENSE](LICENSE)を参照。

## 現状

- Electron製、素のHTML/CSS/JS（PathBrowserと同じ構成方針）。
- 独自形式（`.tline`、中身はJSON）と`.oud`/`.oud2`（OuDia/OuDiaSecond）の両方を、ファイルツールバーの「開く」ボタン1つから開ける（拡張子で内部フローを自動判別）。`.tline`は即座に読み込み、`.oud`/`.oud2`は取り込むDia（1ファイルに複数のダイヤパターンを持てる）を選ぶ2段階フロー。最近使ったファイルの再オープンにもどちらの形式も対応。名前を付けて保存は`.tline`形式のみ（`scripts/screenshot.js`で実際の画面表示・保存/読み込みの往復を確認済み）。起動直後はサンプルデータ（`data/sampleDiagram.mjs`）を表示。
- 運転整理の適用状態・実績タブの入力値も同じ`.tline`ファイル内に任意セクション（`dispatch`/`actual`）として保存・復元される。どちらのキーもない旧来（計画のみ）の`.tline`ファイルも引き続き開ける（[issue #3](https://github.com/Illett0/TLINE/issues/3)で決定）。
- `.oud`/`.oud2`のドット階層構造・駅一覧・列車番号/方向・時刻本体(`EkiJikoku`)・番線番号・列車種別（色/線種）のデコードはクリーンルーム実装（`lib/oudParser.js`）。残課題（エクスポート等）は[issue #1](https://github.com/Illett0/TLINE/issues/1)。
- ダイヤグラムは列車種別（普通/急行/回送等、`.oud2`にある場合）ごとに色・線種を表示し、実際に使われている種別だけの凡例を表示。縦方向（駅間隔）は専用の＋/－ボタンで、横方向（時間軸）はダイヤグラム上のマウスホイールで、それぞれ独立にズームできる。右クリック長押しドラッグで上下左右にパンできる。支線・分岐（駅リストに同じ駅が複数回登場する表現）は上り・下りどちらの方向でも本線区間をまたぐ誤った線が引かれないようセグメントを分断して描画する。
- タイムテーブル（計画・運転整理・実績タブの表）は見出し行・駅名列を固定したまま本体だけスクロールできるスプレッドシート風の表示（縞模様・行ホバー強調つき）。計画・運転整理タブの表は、`.oud2`の`Ekikibo`（駅規模）が参照できる場合、主要駅は着/発/番線の3マス、一般駅は発車時刻のみの1マスを駅ごとに縦積みで表示し、区分が分からない場合（手作成の計画データ等）は着/発の2マスにフォールバックする。
- ヘッダーのセレクトでダーク/ライト/クラシック（OuDiaSecondの見た目を参考にした白背景・角のないUI・10分刻み補助目盛り）の3テーマを切り替え可能（設定は端末に保存）。入出庫記号（○出区/▽入区）・運用のつなぎ線・入出庫運番・折り返し運番・列車番号の5つを独立にオン/オフできる。つなぎ線・入出庫記号は、同一駅・同一番線・短い間隔での折り返しを列車自身の時刻データから検出する方式（`lib/oudParser.js`の`inferOperationChains`）で判定し、つなぎ線は接続元・接続先それぞれの列車種別色で塗り分ける。`.oud2`の`Operation`プロパティのコード自体は入出庫・接続の判定に信頼できないことが判明したため使用していない（詳細はNOTES.md「入出庫の定義」）。
- 列車同士の競合（行き違い・追い越し）チェックは未実装（[issue #4](https://github.com/Illett0/TLINE/issues/4)）。
- `Diagram/`（`.oud2`実データ、git管理対象外）はTLINEフォルダ直下に配置。
- GitHub: [Illett0/TLINE](https://github.com/Illett0/TLINE)。ブランチ運用はPathBrowserと同様dev/main併用、現在はdevブランチのみ。

## 起動方法

```bash
npm install
npm run setup   # インストール時のスクリプト実行を許可制にしているため、許可済みのものを実行（初回・依存関係更新時のみでOK）
npm start
```

## プロジェクト構成

```
main.js                  Electronメインプロセス（ウィンドウ生成・ファイルI/OのIPCハンドラ）
preload.js                contextBridge経由でwindow.tlineを公開
lib/recentFiles.js        最近使ったファイルのMRUリスト（userData配下に永続化）
lib/oudParser.js          .oud/.oud2のクリーンルームパーサ・TLINEデータモデルへの変換（画面接続済み。issue #1参照）
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
