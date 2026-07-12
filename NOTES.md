# 設計メモ

このセッションで決めたこと・保留にしたことのメモ。次回以降の開発の出発点。

**未実装・今後の展望はGitHub Issuesで管理**（[Illett0/TLINE Issues](https://github.com/Illett0/TLINE/issues)）。ラベルはStage分類（`stage-2`〜）・`その他`・タスクの重さ（`軽微`/`中程度`/`重い`）。このmdには「なぜそう決めたか」「現状どう動くか」という設計判断・仕様理解のみを残し、TODO的な記述は極力issue側に寄せる。

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
- **やっていないこと（既知の制約）**: 他列車との競合チェック・停車時間下限チェック・複数列車の連鎖シフトはなし。→ [issue #4](https://github.com/Illett0/TLINE/issues/4)

## 実績タブ（v1）

- 列車×駅ごとに実績の着発時刻をテキスト入力、計画時刻との差分（秒）を計算して表示するだけ。
- 保存は`.tline.json`の保存対象外（計画データのみ保存、実績はセッション限り）。保存形式の検討は[issue #3](https://github.com/Illett0/TLINE/issues/3)。
- 「運転整理で調整した後のダイヤ」との比較は[issue #7](https://github.com/Illett0/TLINE/issues/7)。

## サンプルデータ（`.oud2`）の扱い

- 実データは`TLINE`フォルダ直下`Diagram/`に置かれている（git管理対象外、`.gitignore`で除外済み）。
- 2026-07-13時点で**Claudeが解析目的でNootフォルダの内容を読むこと自体は許可された**（ユーザー本人がAPI送信の扱いを確認した上で許可）。ただし**Noout配下のファイルの中身（駅名・ダイヤ構造・列車番号等の詳細）をこの公開リポジトリに書き出すことまでは許可されていない**——「読んで解析に使ってよい」と「その内容を公開先に記録してよい」は別の許可、という前提を忘れないこと。Noout関連の分析結果を書き残す必要がある場合は、内容を伏せた抽象的な記述に留めるか、リポジトリ外のメモにする。
- **重要な参照データ（git管理対象外の`Diagram/`直下、Noout以外なので詳細を書いてよい）**:
  - `Diagram/高根鉄道TM.oud2` 内の `Dia.` ブロック「`2h"T"Mパターン`」「`2h"T"Mパターン　仕業`」— 後者は仕業（乗務員の乗務ダイヤ）に関連する参考データ。同ファイルは`Dia.`を7つ持つ（`基準運転時分`, `パターンダイヤ2h(没)`, `パターンダイヤ2h-2`, `2h"T"Mパターン`, `2h"T"Mパターン　時刻調整用`, `2h"T"Mパターン　仕業`, `2h"T"Mパターン　仕業　時間調整用`、インデックス0-6）。
  - `Diagram/碧洛電車.oud2` — シンプルな構成。**EkiJikoku解読の决め手になった**（下記参照）。作成途中の簡易版とのことで、駅数が多い点は実データを流用したものらしい。
  - Noout配下にも運行管理の実例データあり（詳細非記載、上記の注意事項参照）。今後EkiJikokuの精度検証等で参照する際は、このリポジトリに内容を書き出さないよう注意。

### `.oud2`フォーマット構造メモ（実ファイルから確認、UTF-8 BOM・CRLF）

```
FileType=OuDiaSecond.1.11
Rosen.
  Rosenmei=
  Eki.
    Ekimei=高岡              # 駅名
    EkimeiJikokuRyaku=高岡   # 時刻表略称
    Ekijikokukeisiki=Jikokukeisiki_NoboriChaku  # 上り着/下り発 等の表示形式
    Ekikibo=Ekikibo_Syuyou   # 駅規模（主要/一般 等）
    EkiTrack2Cont.
      EkiTrack2.
        TrackName=5番線
        TrackRyakusyou=5
      .                      # ← 各ブロックは "." 単体行で閉じる（ドット階層）
    .
    NextEkiDistance=90       # 次駅までの距離（表示上のdiagram距離、実キロ程ではなさそう）
    ...
  .
  Dia.
    DiaName=本線3編成
    Ressya.
      Houkou=Kudari          # Kudari(下り) / Nobori(上り)
      Ressyabangou=A1001     # 列車番号
      EkiJikoku=,,2;204350$0,2$1,2$0,1;204730/$1   # ← 独自の圧縮エンコード（下記）
    .
```

### 階層構造（確定・実装済み、`lib/oudParser.js`参照）

`Block.`で開き、単独行の`.`で閉じるドット階層。`key=value`がプロパティ。同名ブロックの繰り返しは配列として扱う。実際の階層は:

```
Rosen.
  Rosenmei=... (路線名)
  Eki.  (繰り返し、駅の並び順=路線上の順序)
    Ekimei=... / EkimeiJikokuRyaku=... / Ekijikokukeisiki=... / DownMain=.. / UpMain=..
    EkiTrack2Cont. > EkiTrack2.（番線情報、繰り返し）
  Dia.  (繰り返し。1ファイルに複数のダイヤパターンを持てる。現状パーサは先頭の1つしか読まない → issue #1)
    DiaName=...
    Kudari.
      Ressya.  (繰り返し)
        Houkou=Kudari
        Ressyabangou=... (列車番号)
        EkiJikoku=... (★時刻本体、下記参照)
    Nobori.
      Ressya. (同上、Houkou=Nobori)
```

`take-okm`氏の公開マニュアル（`http://take-okm.a.la9.jp/oudia/...`）は調査時点でほぼ404、`oudiasecond.seesaa.net`の「ファイル形式について」記事にも時刻エンコードの詳細記載はなかった。上記階層構造は実ファイル（`高根鉄道28分パターンby Vague.oud2`、Noout外）を`scripts/_analyze-oud.js`（一時解析スクリプト、調査後削除）で機械的に解析して確定させたもの。

### `EkiJikoku`（時刻本体）: 大筋解読済み（`lib/oudParser.js`の`decodeEkiJikoku`参照）

`碧洛電車.oud2`の全駅停車列車「001」（Nobori、20駅すべてに着発時刻あり）が決め手になった: `$`分割すると**21個**（=駅数20+1）のセグメントになり、時刻が単調増加で綺麗に並ぶことを確認。これで以下が確定:

- **`$`は駅ごとのセグメント区切り、駅の並び順どおり**。末尾に駅と無関係な1個の余剰セグメント（数値1個、意味不明）が必ず付く＝セグメント数は「その列車が通る駅数+1」。
- 列車が路線の一部区間しか走らない場合（短距離シャトル等）、その区間の駅数+1個のセグメントしかない＝**どの駅から始まるオフセットかはデータに明示されていない**。`decodeEkiJikoku`は全オフセット候補を試し、デコードした時刻が単調増加になるものだけを採用するヒューリスティックで対処（複数候補が単調増加を満たしてしまう場合は`confident: false`として区別）。
- 各駅セグメント内はカンマ区切りで**番線ごとの候補スロット**（`EkiTrack2`が複数ある駅は複数スロット）。`;`を含むスロットが実データ（`トラック番号;時刻` or `トラック番号;着時刻/発時刻`）、`;`を含むスロットが1つもなければ「通過（停車なし）」。
- 時刻トークンは**4桁=HHMM（秒00省略）、6桁=HHMMSS**（例: `1619`=16:19:00、`204350`=20:43:50）。

**現状の精度**: 全区間走破する列車（駅数+1のセグメント数と一致）は確信度高く(`timesConfident: true`)デコードできる。区間の一部だけ走る列車（`高根鉄道TM.oud2`の「`2h"T"Mパターン`」のような短距離パターンダイヤはほぼ全列車がこれに該当）はオフセット特定に確信が持てず`timesConfident: false`になる。UIへの接続（インポートボタン等）は**まだ未実装**——`timesConfident: false`のデータをそのまま見せると誤解を招くため。残課題（オフセット精度向上・複数Dia対応・UI接続・エクスポート等）は[issue #1](https://github.com/Illett0/TLINE/issues/1)に集約。

## プロジェクト名・GitHub（確定）

- 名称は**TLINE**（トライン）。Train + Line（＝「スジ」）の言葉遊び。旧仮称"SujiOps"から改称、フォルダ名・`package.json`の`name`・`renderer/index.html`のタイトルを一括変更済み。
- GitHub: [Illett0/TLINE](https://github.com/Illett0/TLINE)（作成済み、当初は空リポジトリ）。ブランチ運用はPathBrowserと同様dev/main併用。現時点ではdevブランチのみ作成・push、mainは未作成。

### リリース時の手順（PathBrowserと統一、次回dev→mainマージ時に必ずこの通りにやる）

PathBrowserで実際に使った手順そのまま。「グラフ描画のための手法」＝`git log --graph`やGitHubのネットワークグラフでdev→mainのマージ構造が見えるように、**必ず`--no-ff`でマージする**（fast-forwardさせない）のがポイント。

1. `dev`でバージョン番号を上げるコミット（`package.json`/`package-lock.json`のみ）。コミットメッセージは`vX.Y.Z: バージョン更新`＋変更点の要約。
2. `git checkout main && git merge --no-ff dev -m "Merge branch 'dev'"`（fast-forwardしない＝マージコミットを必ず作る）。
3. `git tag vX.Y.Z`（mainのマージコミットに対して）。
4. `git checkout dev`に戻る（devが普段の作業ブランチ）。
5. `git push origin dev && git push origin main && git push origin vX.Y.Z`。
6. 必要ならビルド成果物を添えて`gh release create vX.Y.Z <asset> --title "TLINE vX.Y.Z" --prerelease --notes "..."`（PathBrowserは`Pre-release`運用で統一されているので、TLINEも安定版が出るまでは同様にprereleaseで良さそう）。

## 動作確認したこと

- `renderer/timeUtils.mjs`・`renderer/dispatch.mjs`のロジックをNode上のスクリプトで直接実行し、時刻の相互変換・シフト計算が意図通りであることを確認（境界: 分をまたぐ加減算、指定駅より前は不変、元オブジェクト非破壊）。
- 全ファイルを`node --check`で構文チェック。
- **GUIを実際に目視確認済み**（`scripts/screenshot.js`、下記参照）: 計画タブのダイヤグラム・表、運転整理タブでの時刻シフト適用（オレンジ点線オーバーレイ、B駅以降のみ変化）、実績タブでの実績時刻入力と差分計算（+552秒等）を実際のスクリーンショットで確認。3タブとも想定通り動作。

### GUI確認用スクリプト（`scripts/screenshot.js`）

- PathBrowserにはない、TLINE独自の開発補助ツール。Playwrightの`_electron`ドライバでアプリを実際に起動し、各タブ・操作後の状態をPNGとして`.tmp-screenshots/`（git管理外）に保存する。
- 経緯: この開発環境にはElectronアプリを直接目視・操作する手段がなかったため、「screenshotを撮ってClaudeが自分でReadツールで見る」という形で解決した。以後、PathBrowserと違いGUIの見た目もセッション内で検証できる。
- 実行: `npm install`（`playwright`はdevDependencies、`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`推奨——Electron自体をブラウザ代わりに操作するのでChromium/Firefox/WebKitのダウンロードは不要）→ `node scripts/screenshot.js`。
- ファイル読み込み・保存などIPCが増えてきたら、このスクリプトに操作シナリオを追加していく想定（PathBrowserの`PATHBROWSER_TEST_*`環境変数によるダイアログバイパスと役割は近いが、TLINEはこちらでUI操作そのものも自動化する）。
