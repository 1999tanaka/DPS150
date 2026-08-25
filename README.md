# FNIRSI DPS-150 Auto Wave Control

FNIRSI DPS-150をUSB接続し、Chrome / Edgeから正弦波状の電圧シーケンスを自動実行する静的Webアプリです。DPS-150との通信はWeb Serial APIを使ってブラウザとUSBデバイスの間だけで行い、測定値を外部サーバーへ送信しません。

公開URL（GitHub Pages）:

<https://1999tanaka.github.io/DPS150/>

## 重要な安全上の注意

- 実験前に、負荷へ適合する **Current Limit** とDPS-150本体のOVP / OCP等を設定してください。
- 初回は固定5 V、OUTPUT ON/OFF、短い1周期試験の順に確認し、最初から約97分のフルシーケンスを実行しないでください。
- STOP、正常終了、通信エラー時にはOUTPUT OFFを送信します。ただしUSB抜去、ブラウザ終了、PCスリープ等では、WebアプリからのOUTPUT OFFを保証できません。
- Command Voltageは設定指令値です。実際のアナログ出力波形はオシロスコープやデータロガーで確認してください。
- 本アプリのDPS-150実機での最終検証は、利用者の機器・負荷・ファームウェア環境で実施してください。

## 使い方

1. DPS-150を会社PCへUSB接続します。
2. ChromeまたはEdgeで上記GitHub Pages URLを開きます。
3. `CONNECT DEVICE`を押し、DPS-150のシリアルポートを選択します。
4. 試験対象に適したCurrent Limitを入力します。
5. A、周期、サイクル数、更新間隔を確認して`START`を押します。
6. 確認画面で配線とCurrent Limitの確認にチェックし、`START OUTPUT`を押します。
7. 実行中はページを前面に保ち、PCをスリープさせないでください。
8. 終了後、必要に応じて`DOWNLOAD CSV`からログを保存します。

会社PCへのPython、Node.js、専用アプリのインストールは不要です。Web SerialはSecure Contextが必要なため、GitHub PagesのHTTPS URLから利用してください。FirefoxとSafariは対象外です。

## デフォルト実験条件

電圧指令は次式です。

```text
V(t) = (7 + A/2) + (7 - A/2) sin(2πt/T)
```

| 項目 | デフォルト |
| --- | ---: |
| A Start / End / Step | 2.0 / 14.0 / 0.1 |
| Periods | 1 / 5 / 10 s |
| Cycles / Period | 3 |
| Update Interval | 50 ms |
| 条件数 | 121 |
| 理論実行時間 | 5,808 s（01:36:48） |

Aは整数スケーリングで生成するため、0.1の繰り返し加算による浮動小数点誤差を避けています。各電圧指令は`performance.now()`による実経過時間から計算し、タイマー遅延による周期ずれを累積させません。

## 実装機能

- Web Serialによる115200 bps接続、セッション初期化、機器情報取得
- 電圧・Current Limit設定、OUTPUT ON/OFF
- A / T / Cycleの自動シーケンス
- STOP最優先制御、二重START防止、実行中の設定ロック
- 0～機器報告上限Vの送信前チェック
- USB切断、送受信タイムアウト、保護状態検出時の異常停止
- OUTPUT ON/OFFの機器応答確認と、未確認時の状態読出し・1回再送
- Command / Measured VoltageのCanvasリアルタイムグラフ（最大2,000点）
- Measured Voltage / Current / Powerと進捗・残り時間表示
- Wake Lock（利用可能なブラウザのみ）とページ離脱警告
- 最大250,000件の実験ログとCSVダウンロード
- 外部CDN、外部API、サーバー側データベース不使用

## ファイル構成

```text
index.html
css/
  style.css
js/
  main.js          UIとイベント連携
  dps150.js        Web Serial・DPS-150プロトコル
  waveform.js      波形計算・設定検証
  experiment.js    実験シーケンス・安全停止
  graph.js         Canvasグラフ
  logger.js        ログ・CSV
tests/
  *.test.js        波形、パケット、CSVの単体テスト
.github/workflows/
  pages.yml        テストとGitHub Pages公開
```

## 通信プロトコル

送信フレームは次の形式です。

```text
F1 <command> <register> <length> <data...> <checksum>
```

- Baud rate: 115200
- Data: 8 bit、parity none、stop bit 1
- Flow control: hardware
- Float: IEEE-754 float32 little-endian
- Checksum: `(register + length + sum(data)) & 0xff`
- Output ON: `F1 B1 DB 01 01 DD`（OFFはデータ`00`）

Current Limit、初期電圧、OUTPUT ON等の制御遷移には60 msのコマンド間隔を設けています。波形更新中は選択したUpdate Intervalを使用します。

通信レジスタとフレーム形式は、cho45氏のMITライセンス実装 [cho45/fnirsi-dps-150](https://github.com/cho45/fnirsi-dps-150) を参考にしています。詳細は[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)を参照してください。プロトコルは非公式のリバースエンジニアリング情報であり、FNIRSI公式仕様ではありません。

## 開発と確認

このアプリはビルド不要の静的ファイルです。開発環境にNode.js 22以降がある場合のみ、次の確認を実行できます（利用者PCでは不要です）。

```bash
npm run check
npm test
```

`main`へpushするとGitHub Actionsが構文チェックと単体テストを実行し、成功後にGitHub Pagesへ公開します。

## ライセンス

このプロジェクトはMIT Licenseです。DPS-150通信実装の参考元に関する表示は[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に含まれます。
