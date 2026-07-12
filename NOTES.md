# 設計メモ

このセッションで決めたこと・保留にしたことのメモ。次回以降の開発の出発点。

## ライセンスについて

- OuDia本体はVectorの配布ページ上で「GPL」と明記（バージョン不明、原作者[take-okm氏]のサイトは確認時点で404。ただしマニュアルの個別ページ（`c02_usersguide`等）は生きている）。
- OuDiaSecondはOuDiaの改造版で、インストーラと共にソースコードもZIP配布 → GPL準拠の体裁。
- 関連ツールのOuDiaParser（KameLong氏、`.oud`/`.oud2`形式のJavaパーサ）は`COPYING.txt`で明示的に**GPL-3.0**と確認済み（`gh api repos/KameLong/OuDiaParser/license`で確認）。同種のブラウザ版エディタ`clouddia`（01397氏）も**GPL-3.0**（`gh api repos/01397/clouddia`で確認）。この界隈では「.oudを読み書きするツール＝GPL-3.0」がほぼデファクトの慣習になっている。
- GPLは「コードを改変・組み込んで配布する場合、その成果物全体をGPLで公開しソースコードを提供する義務」を課す（コピーレフト）。**非商用限定などの追加制限はGPL上認められない**ため、PathBrowserと同じPolyForm Noncommercialのようなライセンスとは併用不可。
- 一方、GPLコードを読んで理解し、独自に書き直す（クリーンルーム実装）のは著作権的に問題ない（保護されるのはコードの具体的表現であって、アイデア・アルゴリズムそのものではない）。ファイル形式自体（ドット階層+key=value形式のテキスト構造という「仕様・事実」）も著作権保護の対象外という一般的な理解に基づく。
- **方針（確定）**: `.oud`/`.oud2`の読み込みは必須機能として実装するが、**OuDiaParser/clouddiaのソースコードは一切参照・移植しない**。代わりに take-okm氏の公開マニュアル（`c02_datafile`/`c03_reference`配下）や、OuDiaSecond公式サイトの「ファイル形式について」記事など、GPLコードそのものではない一次情報からフォーマットを理解し、ゼロから独自にパーサを書く。これによりPolyForm Noncommercialのままでいられる。
- 残存リスクの認識: ファイル形式のリバースエンジニアリング／独立実装は法的にはおおむね安全とされるが、完全にゼロリスクとは言い切れない（判例上の議論はある）。今回は個人の非商用趣味プロジェクトであり、実務上のリスクは非常に低いと判断した。もし将来的に懸念が生じたら、その時点でGPL-3.0への切り替えを再検討する。
- 結論: 本プロジェクトのライセンスは**PolyForm Noncommercial License 1.0.0**（PathBrowserと同一）。`LICENSE`ファイル参照。

## データモデル（v1）

```js
// 計画 (Plan)
{
  line: {
    name: string,
    stations: [{ id: string, name: string, distanceKm: number }], // 順序 = 路線上の並び
  },
  trains: [
    {
      id: string,
      number: string,       // 列車番号（表示用）
      direction: 'up' | 'down',
      stops: [
        { stationId: string, arrival: 'HH:MM:SS' | null, departure: 'HH:MM:SS' | null },
      ], // stations の並び順に対応。始発駅は arrival=null、終着駅は departure=null が普通
    },
  ],
}
```

- 時刻は`HH:MM:SS`の文字列。24時以降（26:30など、深夜帯の列車）も許容（`timeUtils.mjs`の`parseTime`/`formatTime`が対応）。
- `renderer/timeUtils.mjs`: `HH:MM:SS ⇔ 秒数`の相互変換のみを担当。日付をまたぐ丸め処理はしない（OuDiaと同様、24時制を超えた表記のまま扱う）。
- ダイヤグラム描画（`renderer/diagramView.mjs`）は、この列車配列と駅配列だけを受け取るDOM非依存の純粋関数。x軸=時刻、y軸=駅間の累積距離(km)。PathBrowserの`aggregate.mjs`/`mapView.mjs`の役割分担（ロジックとDOM描画を分離する）を踏襲。

## 運転整理のロジック（v1、簡易版）

- `renderer/dispatch.mjs`の`applyDelay(train, fromStationId, deltaSeconds)`:
  - 指定駅**以降**の停車時刻（着・発とも）を一律で`deltaSeconds`だけシフト。指定駅より前は変更しない。
  - 正の値=遅延、負の値=早める。
  - 元の`train`オブジェクトは変更しない（新しいオブジェクトを返す）。
- **やっていないこと（既知の制約）**:
  - 他列車との競合チェック（行き違い駅・追い越し駅での時刻重複、単線区間での対向列車との衝突など）は一切なし。ずらした結果、物理的にありえないダイヤになっていても警告しない。
  - 停車時間（着〜発の間隔）の下限チェックなし。
  - 複数列車を連鎖的にずらす（後続列車への影響を伝播させる）機能はなし。1列車を選んで単独でずらすだけ。
  - これらはOuDiaが本来持っていない/得意としない領域でもあるので、次段階で「実際に運転整理支援ツールとして意味を持たせるには何が要るか」を改めて要件定義したい。

## 実績タブ（v1）

- 列車×駅ごとに実績の着発時刻をテキスト入力、計画時刻との差分（秒）を計算して表示するだけ。
- 保存されない（リロードで消える）。ファイル永続化は未実装。
- 現状は「計画」と比較しているが、「運転整理で調整した後のダイヤ」と比較したいケースもありそう（例: 整理後の目標時刻に対してどれだけズレたか）→ 要検討。

## 未実装・次回検討事項

- ファイルの読み込み・保存（`main.js`にIPCハンドラを追加、PathBrowserの`ipcMain.handle('namespace:action', ...)` + `preload.js`のパターンを踏襲する想定）。
- 保存形式: 独自JSON（上記データモデルそのまま）を正とし、`.oud`/`.oud2`は**インポート必須**（ライセンス欄参照、クリーンルーム実装）。エクスポート（TLINE→`.oud`書き出し）は当面スコープ外、必要になったら検討。
- `.oud`/`.oud2`パーサの実装タスク（次回以降）: マニュアル・公式記事からフォーマットを起こす → `lib/oudParser.js`のようなNode側モジュールとして実装（PathBrowserの`lib/`と同じ「メイン/Worker側で使う共有ロジック」の置き場を踏襲）→ 大きいファイルも想定されるなら将来的にWorker Thread化。
- 運転整理の競合検知（単線区間の行き違い、同一ホーム使用など）をどこまでサポートするか。
- 実績データの入力方法（手入力のみか、外部の運行実績データ形式に対応するか）。
- 複数路線・支線・分岐への対応（v1は単一路線・単純な駅リストのみ）。

## プロジェクト名・GitHub（確定）

- 名称は**TLINE**（トライン）。Train + Line（＝「スジ」）の言葉遊び。旧仮称"SujiOps"から改称、フォルダ名・`package.json`の`name`・`renderer/index.html`のタイトルを一括変更済み。
- GitHub: [Illett0/TLINE](https://github.com/Illett0/TLINE)（作成済み、当初は空リポジトリ）。ブランチ運用はPathBrowserと同様dev/main併用。現時点ではdevブランチのみ作成・push、mainは未作成（将来リリース時にdev→mainマージの運用を踏襲）。

## 動作確認したこと（このセッション）

- `renderer/timeUtils.mjs`・`renderer/dispatch.mjs`のロジックをNode上のスクリプトで直接実行し、時刻の相互変換・シフト計算が意図通りであることを確認（境界: 分をまたぐ加減算、指定駅より前は不変、元オブジェクト非破壊）。
- 全ファイルを`node --check`で構文チェック。
- `electron .`で起動し、`did-finish-load`イベントが発火することを確認（ページの読み込み自体は成功）。ただし**この環境にはElectronのGUIを実際に目視・操作する手段がなく**、3タブの画面表示や運転整理フォームの挙動を見た目で確認できていません。`document.getElementById`の参照先が`index.html`の`id`と全て一致すること、`.tab-button`/`.tab-panel`のクラス名・`data-tab`値が対応することは目視でクロスチェック済みですが、実際に操作しての確認は次回以降にお願いしたいです。
