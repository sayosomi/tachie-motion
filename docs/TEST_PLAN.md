# Test strategy and Phase 0 acceptance criteria

## Test pyramid

- Python unit tests: timeline change-point semantics, independent initial states, lip-disabled mode, LAB units, blink seed reproducibility, bounds computation.
- Renderer golden tests: synthetic PSD with transparent shapes and duplicate layer names; layer order/visibility and alpha expectations.
- Encoder integration: ffmpeg detection, prores_ks + profile 4444, alpha check after decode with ffprobe/ffmpeg.
- OTIO: serialize/deserialize refs, track order, audio only once, gaps and rational timestamps.
- Browser E2E: Playwright import/preview/toggle/change-point/save/export with deterministic fixtures.
- CI: Linux unit jobs plus macOS/Windows where dependencies allow; manual Resolve import is a separate human gate.

## Public Issue #16 — 制作プロジェクトJSON（単一キャラ・複数WAV）

- バージョン付きJSONとキャラクター設定JSONを区別し、複数WAVの順序・安定ID・同一パス重複登録・口パク方式・fps・出力設定・キャラクター設定スナップショットの往復をPlaywrightで確認する。元素材・プレビュー・出力成功結果をJSONに含めない。
- UTF-8/Unicode NFD、未知のバージョン、破損JSON、過大サイズ、重複ID・順序・不正プリセット参照・絶対パスでない入力を拒否。Python unittestではWAVのファイルstat同一性取得と解析中の差し替えを検査する。
- PSD指紋／index-path一致、WAVの有効性と同一性を復元前に再確認。参照切れ・変更は差し替え／明示承認を要求し、未解決なら既存のWAV一覧・プリセット／ブラウザ復旧内容を変更しない。
- 標準Saveダイアログ成功・キャンセル・非対応、ローカルストレージ書込み失敗、二重クリック、読込み確認拒否、保存／読込み中の編集ロックと後着する旧WAV解析結果を自動検査する。
- Mac Humanは実素材で保存先・ファイル名、ブラウザリロード後の読み込み、参照修正の分かりやすさ、一覧画面内での操作性のみを評価。自動テスト済みの異常系を人手で反復しない。ProRes／PCM／OTIOのエンコード契約に変更なし。独立レビュー・CI・Mac Humanを別々のゲートにする。

## Public Issue #18 — 一括命名・全体OTIO 1本

- MOVの`{番号}_{キャラ名}_{WAV名}`、全体OTIOの`{プロジェクト名}`と4プレースホルダーの展開、一覧並べ替え、Unicode NFD、同一WAV複数登録、重複名・禁止文字・長い名前・未知の括弧式をPlaywrightで検査。
- 現在の表示済み予定と実行直前の出力先を比較し、不一致・symlink・別方式の復旧領域を安全側に停止。上書き／別名選択をPlaywrightで検査し、別名はMOV群と全体OTIOへ同じ連番を追加。完全な旧世代を保存した後でのみ全件公開することをバックエンドで保証する。
- 一括上書きの故障注入：2本目MOV・全体OTIOの公開時、既存ファイルの外部変更、バックアップ途中失敗、ロールバック失敗、回復領域削除失敗。通常の途中失敗時は旧MOV群と旧OTIOが不変、異常停止時はmanifest/old-*が残り、同フォルダの新規書き込みは停止する。
- 2026-11-14独立監査の公開・復旧および一時ステージの回帰：元MOV照合直後の外部差し替え、旧MOV移動後に第三者が作成したファイルを故障注入し、公開先・復旧領域の第三者ファイルを削除しない。公開前のMOV／OTIO・旧ファイル本体・各ディレクトリのfsyncも検査する。**一時ステージは通常終了・取消・10分失効・異常終了のいずれでも自動でunlink／rename／rmtreeしない**。同名の第三者MOV、未登録ファイル、ネストした一時ディレクトリ、symlink、FIFO、深い破損JSONを含むステージは全内容を保持し、leaseのみを解放して次のバッチを開始できることを検証する。削除直前の差し替えについては、そもそもステージ破棄からファイル削除APIを呼ばないことを故障注入で保証する。正常な一括公開後もステージ側のMOV／OTIOハードリンクは手動整理まで残ることを確認する。
- PythonでPCM内包MOVの連続タイムラインJSONを構築し、映像・音声トラックが同じMOVを参照し、各発話のPCMサンプル時間を厳密に保持することをテスト。MOVが1件でも失敗した場合に全体OTIOを出さない。
- 個別出力のMOV＋個別OTIOを変えず、一括出力で個別OTIOファイルを作らない。テストは公式OTIOが利用可能なCI jobでroundtrip検査し、Mac Resolve Humanは取り込み・見た目・実際の音声同期を別判定。
- 既存JSON v1の読み込みと、新v2での命名設定保存／復元をテスト。元PSD/WAV/LAB不変、ProRes全フレーム検査とPCMロスレス検証を維持。
- PR #19独立監査HIGH-01 / MEDIUM-01〜03 / LOW-01〜02の回帰：WAVの登録時と公開前のstat同一性、MOV/OTIO両方式の復旧場所、NFC+casefold、別タブのバッチ占有と生成MOV inode検査、0 WAVの旧v1移行、os.link/renameとバックアップ削除失敗をPythonとPlaywrightで検査。

## Phase 1 Slice 1 — PCM WAV音量・口状態スケジューラ

- 合成整数PCM WAV（8/16/24/32-bit、mono/stereo、逆位相stereo）からフレーム別RMSを独立検査。
- フレーム境界は整数演算で算出し、24/30/60fps、サンプル数が割り切れない尺、末尾端数、開閉閾値境界とヒステリシスをテスト。
- 壊れたWAV、非対応フォーマット、無効な閾値・fps、出力先既存ファイルの拒否、Unicodeパス、元素材不変性、JSON決定論性を自動テスト。
- 本SliceでPSD口レイヤーの切替、MOV/OTIO、Resolve互換性は保証しない。後続Sliceで別途検証。


## Phase 1 Slice 2 — PSD mouth binding → MOV/OTIO

- 合成PSDの閉／開口を手動インデックスパスで指定し、元PSDの別レイヤー・可視状態・ファイルバイト列が維持されること。別名同名でもインデックスで区別し、隠れた親グループや不正指定は拒否。
- WAVフレーム列の開閉順をProResに渡し、可変長保持、24/30/60fps、非整数サンプル長・最終切上げフレームを検証。
- 結果MOVの全フレームを復号し、各フレームを**対応する期待口状態のRGBA**に照合。透過・色情報・変更領域・全ブロックの既存精度ゲートを維持し、誤った口状態対応を失敗させる。
- WAVを1回だけ参照する個別OTIOは音声のサンプル長を保持し、MOVだけ切り上げフレーム長とする。開始時刻は共通0、公式OpenTimelineIOでserialize/deserializeする。
- MOV・OTIOが既存の通常ファイルやシンボリックリンクの場合は上書きせず、エンコード・OTIO失敗時は不完全な出力を公開しない。元PSD/WAVは変更しない。
- Linux CIの合成素材検査と独立コードレビューを経て、Macの元PSD+WAV、DaVinci Resolveでの透過・シーク・同期は独立Humanゲートとして報告する。


## Phase 1 Issue #16 — Resolve互換のWAV参照（コピーなし）

- Mac Resolveで確認した診断：元の日本語・NFD WAVを`file://`で参照するとオフライン、同じ元WAVを通常の絶対パスで参照するとPASS。英数字名のコピーWAVは両形式でPASS。原因の一般化はせず、この実例に対する互換調整に限定する。
- `tachie-mouth-render`の個別OTIOでWAVの`target_url`が元WAVの絶対パス（`file://`なし）になること。MOVのURIは変更しない。
- 空白・日本語・Unicode結合文字を含むWAVパスをそのまま保持。WAVは複製・変更せず、OTIOは1音声トラック1参照のみ。
- 公式OpenTimelineIOでserialize/deserializeしてパス・開始位置・サンプル精度を保持。生成MOVのProRes品質検査とフレーム数は回帰させない。
- 元WAVがない場合、出力先競合・異常系に対する既存ガードを維持。外付けSSDが外れた際の参照切れは仕様として明記する。
- 自動テストと独立レビュー完了後、**新しく出力したOTIO**をMac Resolveで読み込み、MOV・WAVが自動オンラインで映像・音声が同期することをHuman E2E確認する。診断用OTIOのPASSで代用しない。

## Phase 1 Slice 3 — 最小ローカルWeb画面

- FastAPIは127.0.0.1で起動し、HostとPOST Originを制限。JSON以外のPOST、想定外Host、外部Originは拒否。APIが外部ネットワークやクラウドにデータを送らない。
- 任意のTailscale Serve経由アクセスでは、明示設定したHTTPS `*.ts.net:8443`の正確なHost/Originのみ追加で受理する。設定未指定時はlocalhost限定、異なるHost/Origin・HTTP・無効URL・異なるポートは拒否し、通常のローカル操作も回帰させない。実MacのTailscale Serve経由ChromeでのGET・JSON POST成功はCIとは別Humanゲート。既存のVoiceger 443番は変更しない。
- PSD元ファイルの階層・同名のレイヤー・インデックスパス、現在表示と閉口／開口のPNGプレビューを確認。PSDバイト列不変。
- WAVのサンプル数・周波数を取得し、元WAVは変更・複製しない。Unicode・空白・結合文字を保持。
- UIの書き出しは既存`export_mouth_animation()`に委譲し、ProRes全フレーム復号・音声同期・出力非上書きの契約を維持。複製メディアを作らない。
- 合成PSD/WAVでPython APIと実FFmpeg統合テスト、React/TypeScriptのビルド、Playwrightの選択・プレビュー・書き出し操作を検証する。
- 口閉・口開レイヤーを再指定した直後、以前のPNGプレビューと「開いた口／閉じた口」のラベルを破棄し、再プレビューで新しい指定を送信する。出力ファイル名、fps、出力フォルダの変更後も古い成功結果を非表示にする（Playwrightで再現・回帰検証）。
- Web APIの書き出しではプレビューと同じPSDキャンバス最大6,000万画素を、WAV解析・PSD合成・FFmpeg開始**前**に検証する。超過する10,000×10,000の合成メタデータを使い、レンダラー未呼び出し・出力未公開・原本不変を検証する。既存CLIのサイズ制限は変更しない。
- Mac M1で実PSDとWAVを入力するUI操作（遅延、プレビュー品質、書き出し）とResolveでのMOV＋OTIO取り込みはCIとは別ゲート。Windows実機はUNTESTED。
- ファイル選択ダイアログ、WAV波形再生、複数ファイル、編集タイムライン、保存は後続スライス。

## Phase 1 Issue #21 — PSDレイヤーツリー・口/目の手動指定

- ツリーはPSDの元順序・グループ階層を保持する。各グループの開閉、すべて開く・すべて閉じるを実ブラウザで操作し、深い子レイヤーが閉じた親の下で表示されないこと。展開後は元のインデックスパスが変わらないこと。
- 口（閉口・開口）、目（開眼・閉眼）は別モードで選択し、グループを閉じても既存の選択が保持されること。選択後の静止画プレビューAPIが選択したインデックスパスを使用すること。
- 口/目の選択変更で古いプレビューを無効化し、既存の口閉・口開プレビューと1-WAV MOV/OTIOエクスポートを回帰させないこと。
- 口・目の各割当は、現在選択中の同じボタンを再押下する操作と、一覧の明示「解除」ボタンで未選択に戻せること。解除直後の選択状態・古いプレビューの破棄・閉口または開口未設定時の書き出し無効化・再割当後の書き出し再有効化をPlaywrightで確認する。
- **瞬きのMOV合成は未実装**。目の割当は静止画プレビューに限定され、Web UIが出力に目の瞬きを含むと誤認させないこと。
- Playwrightで合成された階層・同名レイヤーを検証。同名グループ・同名レイヤーの操作ボタンはインデックスパスを含む一意なアクセシブル名を持つこと、口／目タブの `aria-pressed` が現在の選択と一致することを確認する。口閉・口開／目開・目閉のプレビューリクエスト、目の再指定時の古いプレビュー破棄、同じPSDパスの再読み込みに対するツリー展開状態の再同期も検証する。Mac実PSDのグループ操作と目の静止画プレビューは独立Humanゲート。CI成功だけをMac実機PASSにしない。

## Issue #29 — Android Web/Serve一括起動の検証

- Linux CIではTailscaleサーバーや8443番を起動しない。CLI・プロセス・ヘルスチェックをmockし、正常起動、HTTPS未到達、既存443番保持、8443番の他宛てルート/Funnel拒否、自己所有子プロセスだけの停止を確認する。
- 8765番が使用中の場合に他のPythonプロセスを停止・上書きしないこと。WebとHTTPSの**両方が成功するまで**READYを表示せず、失敗時に所有プロセスを停止すること。
- Mac実環境では`tailscale serve status`の実際の8443番ルートと443番の不変を確認し、Android ChromeからHTTPS・新UIへ接続できることをHuman E2Eで確認する。Ctrl+C後に8443番が解除され、443番は残ることを別ゲートとする。
- D20に従いバックグラウンド常駐やFunnelは使わない。実機のE2EをLinux CIでPASS扱いしない。

## Phase 2 Slice 2 — 統合プリセット一覧・詳細編集（Issue #27 / PR #28）

- PSD読み込み時の元レイヤーON/OFF・階層を保った初期プリセット、独立した詳細画面の画面遷移、既定ID・名前変更・複製・削除確認・順序変更をPlaywrightで確認。IDが名称や表示順に依存せず、新規複製で新IDを発行すること。
- Androidのタッチ環境に対する上下移動ボタン（HTMLドラッグ操作が利用できない環境の代替）、小画面レイアウト、旧書き出しタブへの退避と既存書き出し回帰を確認。
- 合成PSDのグループ・同名レイヤー・非表示親を含むすべてのindex-pathを厳密に1回指定し、二値ON/OFFのプレビューが合成され、元ファイルバイト列を変更しない。欠落、余剰、重複、誤型、PSD変更済みスナップショットを拒否する。
- PSDのプレビューでは親グループの可視性を勝手に修正しない。口・目の動的上書き優先順位を未決のまま保持する。
- 設定はセッション限定であり、ブラウザ再読み込み後に失われることを明示してテスト。実運用のプロファイル保存、参照付きプリセット削除、LAB、複合アニメーション、プリセット連動MOV出力は本SliceのPASSに含めない。
- GitHub CIの合成PSD/API/PlaywrightとAndroid実ブラウザ・Mac実PSD・Resolve Human E2Eは別判定とする。

## Issue #31 — プリセットUI再読み込み復元と操作性

- 同一ブラウザ・同一オリジンで新規作成、複製、削除、レイヤー表示変更、並び替え、既定プリセットID、未確定の改名を保存し、リロードで**元PSDを再取得・fingerprint/index-path照合後**に同一ID・順序・可視状態で復元する。保存対象は絶対パスとJSON設定のみで、PSD/WAV/画像をブラウザ保存しない。
- 元PSD不在またはfingerprint不一致で復元を停止し、既存保存データが残ること。明示破棄前に上書きしないこと。不正JSON・異常な型・不正ID・不正index-path・ブラウザ保存APIの失敗を確認する。
- 新規と複製でユニーク名を採用し、改名の重複（前後空白・Unicode正規化・大小文字の表記揺れを含む）を拒否する。内部IDは不変。
- ドラッグ可能な対象を視覚・アクセシブル名で示し、スマホでは上下移動ボタンのタップで再配置できること。大きな見出しの重複、英語サブタイトル、旧タブ名称が整理されていることを確認。
- browser localStorageは誤リロード復元用。正式なキャラクター設定JSON・異ブラウザ共有・制作プロジェクト保存をPASS扱いしない。CIのPlaywrightとAndroid実Chrome Human UXは別ゲート。

## Issue #44 — キャラクター設定JSON（制作プロジェクトとは独立）

- Chrome/Edgeの標準保存ダイアログにJSONの初期ファイル名・拡張子を指定し、選んだ保存先にだけ書き込む。成功を明示し、キャンセルではファイルを作成せず、書込失敗時はエラーと書込ストリーム破棄を確認。連打による複数ダイアログと重複保存を防止。非対応ブラウザで黙って複数ダウンロードを発生させない。PlaywrightはダイアログAPIをモックし、Mac Chromeの実ダイアログはHumanで別途確認。
- エクスポートしたversion付きJSONを別ブラウザセッションでインポートし、PSD参照・fingerprint・全index-path、既定プリセットID、プリセットの安定ID・順序・Unicode/NFD名、base ON/OFF、Openの複数レイヤー設定が保持されること。ブラウザの未確定改名・プレビュー画像・素材本体はファイルに含めない。
- 壊れたJSON、2MB超、未対応format/version、余分な項目、不正型、重複ID・名前・レイヤーパス、欠落base・不正な口形参照、既定ID参照不正を拒否し、既存編集・ブラウザ自動復元コピーを変更しない。
- 元PSDの参照切れ、fingerprint差異、レイヤーパス差異は、候補を推測して自動関連付けせず明示エラーで拒否。読み込み取消し、保存APIの失敗、非同期PSD再検証中の編集競合でも状態を保護。
- Python API・旧口パク書き出しの動作とPSD/WAV原本に変更がないこと。JSONの保存→別ブラウザセッションでの読み込み・設定一致・自動復元、異常系はPlaywrightとCIの自動テストで担保する。Mac Humanは実ブラウザの標準保存ダイアログ、保存先・名前の選びやすさ、通知の見やすさなど**見た目と操作性**を評価し、自動テストで担保済みのJSON内容・復元の一致を手動で繰り返さない。GitHub Actions上限時はCI PASSを報告しない。Resolve再検証は映像生成経路を変更しない本Issueの対象外。

## Phase 2 Slice 1 — 統合プリセット内部モデル（Issue #25 / merged PR #26）

- 合成データのPython単体テストで、レイヤーON/OFFの明示性、インデックスパス・重複指定・不正型の拒否、プリセットIDの独立性と既定IDの参照整合性を確認する。
- 一つのプリセットにopenとaiueoの両口形セットおよび複数レイヤーの目状態を同時に記録でき、複製後の変更・改名・並び替えが既存インスタンスとIDに影響しないことを確認する。
- 日本語・NFD文字・重複名を改変しない。参照不正、重複ID、欠落・重複を含む並び順は拒否する。
- **対象は純粋データモデルのみ。** PSDとの結合、保存形式、削除時の参照処理、動的上書きの優先順位、Web UI、動画出力、Mac/ResolveのHuman E2Eは後続ゲートである。既存の最新仕様の未決事項はここで決定しない。

## Phase 2 Issue #23 — 統合プリセットと複合口形／目状態（計画・未実装）

- 1 PSDに複数の表情＋ポーズ統合プリセットを作成、独立複製・名称変更・削除・ドラッグ並び替え。名前や順序に依存しない安定IDで既存のタイムライン参照を保持。削除時は参照との関係を検証する。
- プリセットごとのPSDレイヤーON/OFFは二値。口パク・瞬きの状態は複数レイヤーから作成可能で、切替対象外のレイヤーに影響を与えない。元のPSDの階層、同名レイヤー、非表示の親グループ、レイヤー順、透過、固定キャンバスを確認。
- 同一プリセットでopen（閉口／開口）とaiueo（あいうえお・ん）を個別に登録できること。WAV×キャラクターの選択が「なし」「open」「aiueo」を切り替えてもプリセットの複製を必要としないこと。
- WAVと同じフォルダ・同じ元ベース名のLABを自動検出し、日本語・空白・Unicode結合文字を保持。不在・壊れた内容・無効な時間範囲／音素ではaiueoを使用不可にして明示し、自動的にopenへ変更しない。LABなしでもopen／なしが動作する。
- aiueoの「ん」が無音時に使用され、同一のWAV／LAB・プリセット設定・乱数シードから同じフレーム列を再現できること。
- プレビューと書き出し結果が同じ表示状態を合成することを、合成PSDと実FFmpeg復号・画像照合で検証。コード／CIの結果と、Mac実PSD・DaVinci ResolveのHuman E2Eは別途判定。
- 親グループの可視性、口と目の対象レイヤー重複、以前の単一パス割当からの移行などは詳細設計を決定してからテスト期待値を固定する。ユーザー未承認の優先規則を仮定しない。

## Phase 0 gates

1. Original PSD hierarchy is preserved and duplicate names do not alias each other.
2. Human selection can toggle distinct mouth/eye layers with unmodified PSD.
3. A short alpha MOV is generated with fixed bounds and no unexpected crop shift.
4. Independent inspection confirms alpha, profile, expected frame count and readability.
5. In Resolve, MOV overlays actual footage with clean edges and consistent position.
6. Resolve imports a simple OTIO referencing 1 WAV and 1 MOV in sync.
7. Report explicit PASS/FAIL/UNTESTED for each gate on exact version and OS.

## Fixtures and media safety

Use self-authored / permission-cleared synthetic test PSD and WAV in CI. Do not commit copyrighted fan-art character sources, user recordings, or video exports. Store only metadata or hashes in diagnostics, with paths redacted where appropriate.

## Issue #35 — PCファーストのプリセット一覧レイアウト

- 1100/1440/1920px のデスクトップ画面で、カードが幅245pxのタイルへ縮退しないこと。画像・操作領域が別列になり、プレビューと各操作ボタンの矩形が重ならず、カード領域からはみ出さないことをPlaywrightで検証する。
- 複数プリセットでも同じ横長レイアウトを維持。狭い画面は補助レイアウトとして既存の追加・並べ替え・詳細編集を維持する。
- ブラウザ自動復元・PSD不変・MOV/OTIO処理は変更しない。新しいプリセット起点の動画書き出し機能はIssue #36で設計・実装し、旧試験版のResolve実機ゲートは求めない。

## Issue #36 初回Slice — PCファーストのプリセット基準・単一WAV書き出し

- 新「セリフ」画面から旧「動画書き出し（試験版）」画面への依存がなく、同じPSDスナップショットのプリセットID・base可視状態・open口形の複数レイヤー割当がAPIへ正しく渡ること。
- プリセット側にopen口形がない場合、両口形が同じ場合、または元PSDのfingerprint/レイヤー集合が変更された場合、出力禁止。aiueoと瞬きは未実装で、無断フォールバックや出力しながらの省略をしない。
- 合成PSD/WAVのnone/openで透過ProRes MOV＋個別OTIOを生成。WAVサンプル長を保持し、動画は末尾切上げ、MOV全フレーム品質検査を既存エンコーダで実施。PSD/WAV原本バイト列不変、出力競合時非上書き、途中失敗時の片方だけ公開を防止。
- PlaywrightでPC上のプリセットopen口形定義→WAV→モード選択→新APIを確認し、既存旧試験版UI経由のE2Eは廃止する。
- 複数WAV・aiueo LAB・瞬き・変更点・待機・全体OTIOは本SliceのPASSに含めない。Mac/Resolve実素材は独立Humanゲート。

## Issue #20 Mac専用Finderファイル選択（PR #39）

- Mac通常操作: `scripts/run_mac_web.py` は前面で現在のWeb版をビルドし、localhost:8765（本体）/127.0.0.1:8766（Finder専用）の両方の健全性が取れてからのみREADY。両方ともCtrl+Cで終了、既存の占有ポートを変更しない。Tailscale Serve/Voiceger 443番は不変。
- 専用APIの操作は `GET /health`（副作用なし）と `POST /pick`（psd、wav、output_dir固定）に限定。要求はexact Host/Origin、ローカル接続元、JSON Content-Typeと非単純カスタムヘッダーを検証。未承認・遠隔・CSRF・不正kind・同時要求のときFinderを開かない。通常Web 8765にOSダイアログ操作を生やさない。
- AppleScriptの成功/キャンセル/失敗・実在しないファイル/誤拡張子/権限エラー・Unicode結合文字と空白/出力フォルダをモック+Mac実機で確認。原本を変更せず、キャンセルしても既存プリセット編集状態を失わない。
- PlaywrightでFinder選択→PSD自動読込、WAV自動解析、出力フォルダ選択、直接パス入力の補助機能、Tailscale/通常サーバー時の選択不可表示を確認。Finder操作テストのMac実環境は別ゲート。
- 本SliceでFinderドラッグ＆ドロップ・Windows対応・macOS以外のファイラー実装はPASS扱いしない。ブラウザのFileオブジェクト経由でPSD/WAVを勝手にアップロードしない。

- Finderの開始場所はPSD/WAV/出力先で独立し、成功した選択のディレクトリだけを同一ブラウザのlocalStorageへ保存する。後続選択で該当種類の場所がAppleScriptの `default location` へ引数として渡ること（スクリプトへの文字列埋め込み禁止）。キャンセルは更新しない。
- 外付けSSD切断などで記憶場所が存在しない/不正になった場合は通常のFinderダイアログにフォールバック。日本語・空白・結合文字を改名・正規化しない。記憶場所とファイル本体をGitに含めない。

## PR #39 audit blockers H-01 / M-01 / M-02

- CI web-ui workflow directly runs `test_native_picker.py` and triggers on changes to that test. Python PoC matrix installs `.[web-test]` so picker security tests cannot skip from absent TestClient dependencies. A missing dependency/import MUST fail the test module; an unrelated 0-skips test is not acceptable evidence.
- Finder PSD selection is transactional: a prompt cancellation, invalid PSD, fingerprint mismatch or failed API call MUST NOT update the selected path, previously loaded preset snapshot, or recently used folder. Success commits all states and the remembered PSD folder. Preserve normal manual-path draft behavior.
- Browser mock E2E creates a real preset edit then cancels the native dialog, rejects a chosen replacement in the confirmation prompt, and verifies exact saved draft/path/folder and that no second PSD load occurs. Distinct tests cover plain-server no-sidecar and Tailscale-origin disabled states.
- Real concurrent picker API requests: first dialog holds a synchronization event; second must receive 409 without invoking a second dialog. Launcher tests cover occupied port rejection and cleanup after second-child start failure or unexpected child exit. CI/macOS Human/independent code review remain separate.


## Issue #40 — 同じレイヤーツリーでOpenの役割指定

- ベースのON/OFFと右端の役割（`—`／閉じ口／開き口）が互いに独立し、1完成口形に複数レイヤーを割当可能なこと。旧「ON」「OFF」冗長ラベルがないこと。
- 85枚以上の合成レイヤーを持つPSDで、元の階層、グループの開閉、検索、割当済みフィルタを検証。インデックスパスで同名レイヤーを区別すること。
- 基本／閉口／開口プレビューで既存の`/api/preset-preview`に正しい完全表示状態が渡り、元PSDは書き込まないこと。
- 役割の追加・解除・変更・プリセット間独立性・リロード後の復元を確認し、旧保存済みの同時ON/OFF等を編集しない限り保持すること。
- `aiueo`／`目・瞬き`は未実装と明示し、誤って編集・書き出しできないこと。未決の目口競合や隠れた親の自動修復は行わないこと。
- Python/Playwright/TypeScript、独立コード監査、Mac実機プレビュー・操作性、Resolveによる新経路受入を別々に記録すること。


### Issue #40 — 縦長PSDのプレビュー視認性

- 合成1500×3300 PSD相当の縦長画像が360px固定プレビュー内へ縦横比を維持して収まり、頭部でクリップされないこと（DOM画像のabsolute containment / contain検証）。
- 拡大・縮小、上限、全体に戻す、ドラッグまたは矢印キーによる移動、口形対象の外接矩形へのフォーカス（レイヤー未割当時は不可）をPlaywrightで確認。
- 基本表示／閉口／開口の切替後も拡大率と位置を維持。PSDパスのfingerprint・レイヤー状態、元PSD、書き出し範囲は無変更。
- 実PSDの口の視認性・動きや操作性はMac Humanの別評価とし、自動ブラウザ合成でPASSを代用しない。


## Issue #42 — 新セリフ出力の衝突時操作

- 出力先照合は読み取り専用。空き、MOVのみ、OTIOのみ、MOV+OTIO、シンボリックリンク、バックアップ残存を区別。未使用の候補名は両拡張子が存在しないことを確認。
- UI：同名なし→通常書き出し、両方あり→上書き（既定）／別名、片割れ・特殊ファイル→別名のみ。実際のAPIリクエストに明示的な `conflict_policy` が渡る。
- バックエンド：出力レンダリング失敗時は既存2ファイル不変。MOV公開後OTIO公開失敗を故障注入で再現し、両方元に戻ること。外部変更によるTOCTOUを可能な範囲で検出し、上書きを中止。
- 異常終了で残る `.<basename>.tachie-backup` は元ファイルを残して同名再書き出しを拒否すること。復旧を誤って完了扱いしない。
- ユーザーの実Mac書き出しとDaVinci Resolveの映像透過・音声同期確認はCIと別ゲート。

- 上書きの競合故障注入：既存MOVの退避直前の外部置換、退避後かつ新規公開直前の外部作成で、新規公開が既存ファイルを無条件に置換せず、外部内容が復旧領域または出力先に残ること。
- MOV公開後OTIO公開失敗時の通常ロールバック、および両ファイル公開後のバックアップ削除失敗は別試験とする。後者は成功＋警告を返し、新しいMOV・OTIOを失敗扱いしない。外部同一inodeへの非協調的な書き込みや電源断は完全保証の対象外。
- 新規出力の復旧領域はMOV公開前に確保する。確保失敗（例：空き容量不足）とOTIO公開失敗を独立して故障注入し、片割れや誤上書きが残らないこと。外部書き込みが混入した `.<basename>.failed-*` は復旧対象として再プローブと同名再書き出しを拒否し、別名は利用できること。
- 生成済みMOV・OTIOの公開後に一時レンダリングディレクトリ削除が失敗した場合、APIはHTTP 200＋警告を返し、既存ファイルを維持すること。新規・上書き両経路を合成素材で検証し、UIが警告を表示すること。


## Issue #47 — 同一PSD/プリセット表示状態のプレビュー結果キャッシュ（Slice 1）

- 合成PSDで同一の元パス・PSDファイル識別子・fingerprint・レイヤー完全表示状態を繰り返し要求すると、最初の1回だけ合成し、以降は完成済みPNGを再利用する（キャッシュヒットをモック合成呼び出し回数で検証）。
- 別状態、別PSD（パス）、同一size/mtimeでのファイル置換（inode変更）を区別すること。異常な表示状態、重複・欠損レイヤー、無効値・古いfingerprintはキャッシュにかかわらず拒否する。
- 古い画像が残らないよう、合成中/応答直前のPSD変更を検出する。合成失敗はキャッシュに保存しない。共有ミュータブルPSDなし、bounded LRU 6状態を確認する。並行要求の二重合成と不整合を許容しない。
- 同じ状態の結果は従来PNGとバイト一致（元PSD不変）。PNG内容、MOV/OTIO出力契約、Openの親レイヤー処理を変更しない。
- Mac実PSDのcold(新規状態)とwarm(同じ状態)を同一素材・環境で計測。**初めて表示する状態の約2秒は本Sliceで未解決**として明記し、別の改善Sliceで検討する。
- CI、独立レビュー、Mac実PSD検証を別ゲートとして扱い、実施していない検証をPASSと報告しない。

## Issue #47 — 変更領域のみのPSD再合成・事前評価（Slice 2 / Mac単一状態PASS・追加検証待ち）

- `scripts/probe_psd_preview_roi.py` は**検証専用**であり、製品のPSD表示・MOV出力経路は変更しない。
- 1500×3300pxの実PSDで、同一インスタンス・同一レイヤー切替に対するフルRGBA合成と、対象レイヤーbboxだけの `PSDImage.composite(viewport=...)` を独立計時する。レイヤーの大きさ・種類・bbox面積比を出す。
- ROI描画の画素とフルRGBAのROI切り出しをバイト一致で比較し、**元RGBAへROIを貼った全キャンバスが変更後フルRGBAと全画素一致**するか検証する。透明画素のRGBも含め、誤差許容値や画質・透過の引き下げは認めない。
- 矩形外へ影響するグループ・マスク・エフェクト・クリッピング・調整レイヤー等で不一致が出れば、部分合成を採用しない。1つの実PSDと1つのレイヤー状態で一致しても、他の状態の安全性を保証したことにはならない。
- 実PSD原本のSHA-256とstatを実行前後で比較する。原本へは一切保存しない。大きすぎる素材での診断によるメモリ超過を避け、計測用スクリプトの上限を600万画素とする。
- 自動テストは合成PSD・不正ROI・矩形外の差分検出を担当。Mac Humanの性能・RSS・画像同一性計測および将来の本体組み込み可否判断は独立ゲート。診断のみの時点で「新規状態が高速化した」と報告しない。

## Issue #47 — 有界RGBAフレームキャッシュと保守的ROI高速経路（Slice 3）

- 初回`/api/psd`で生成したフルRGBAを1状態だけ保存し、上限32MiBを超えるPSDは保存しない（PNG 6状態LRUと別）。共有mutable PSDImageは保持しない。画像の縮小は元RGBAへの変更を避ける。
- 同一PSDの厳密なstat識別子・全index-pathのON/OFFが一致し、かつ差分が単一ピクセルリーフで、その矩形がキャンバス40%未満の場合に限りROI経路へ進む。高速経路が実際に呼ばれ、全面再合成が実行されないことをモックで検証。
- グループ変更、複数レイヤー変更、複雑なブレンド・マスク・エフェクト・クリッピング・透過・非RGB/8bitなど未承認な状態、範囲外・巨大ROI、ROI合成失敗では従来の全面合成にフォールバック。静的安全検査では合成範囲外への影響を完全保証しないため、Mac実PSD画素比較を別途要求。
- 全解像度RGBA・縮小後RGBA・PNG復号後RGBAは、透明画素のRGBとalphaを含め全面合成と全画素バイト一致させる。PNGのIDATおよびICC以外のチャンクも照合し、色管理メタデータを落とさない。psd-toolsが再合成のたびにICCプロファイルの作成日時（ヘッダー24〜35バイト）を更新する場合は、**その12バイトだけ**を例外とし、ICCの残りの全バイトを一致させる。異なる時刻の独立レンダリングでPNG Data URI全体のバイト一致を要求しない。キャッシュが返す同一生成結果はバイト一致させる。重複名前・非表示親・グループON/OFF・閉/開口、画質とキャンバス境界は維持する。
- 元PSDの同時変更、inode/ctime差異、表示状態が複数プリセット間で異なる場合、並行リクエスト、失敗中のキャッシュ公開抑止、メモリ上限、キャッシュ失効を自動テスト。
- Mac実PSDでは新規1レイヤー変更の全面合成とROI・API応答・ブラウザ表示・デバウンスを分け、同条件で画素一致と時間、ピークRSS、原本ハッシュを計測する。特殊レイヤーの安全性も調査し、適用不能でも安全なフォールバックが働くことを確認。
- 旧MOV/OTIO/ProResの処理は変更しないため、Resolve再検証は直接の必須条件としない。GitHub CI／独立コード監査／Mac実機Humanを別々の合格条件とする。


## Issue #55 — Canvas合成の製品プレビュー統合

- 安全条件を満たすPSDのみ縮小個別レイヤーPNGを受け取り、元のindex-path・描画順・親グループ可視性と全表示状態に基づくブラウザ合成を行う。通常の初回Pythonプレビューは維持。
- RGB/8bit以外、非通常ブレンド、マスク・調整・効果・半透明レイヤーや予算超過、API失敗、画像復号/Canvas失敗時に従来の`/api/preset-preview`を実行したことを自動テストで確認。特殊PSDの書き出しは以前と同じ。
- 元PSDの外部変更とfingerprint変更の検出、別PSD・同名index-path・親非表示、Open閉口/開口、プリセットの連続トグルと古い非同期結果の破棄をテスト。画像転送量・縮小後デコード量・元のレイヤー寸法/合計面積の制限、ImageBitmapの解放を確認。
- Python合成結果との比較ではプレビューの輪郭等の近似を許容。MOV/OTIOの合成とアルファ/カラーの正確性を下げない。Mac実PSDでの視認性・切り替えの体感と初回準備時間は独立したHuman評価。
- CI PASS/独立コード監査/Mac Humanを分け、実施していないゲートをPASS報告しない。

### Issue #55 — independent review MEDIUM-1 / MEDIUM-2

- Canvas準備完了後のPSD外部保存、同一size/mtimeのinode差し替え、ファイル削除は、full stat識別子（dev/inode/ctime_ns/size/mtime_ns）照合で無効化する。確認APIはPSD再Open・合成・レイヤー復号を実行しない。
- Canvas編集は軽量なファイル確認完了後だけ描画する。外部変更・確認API失敗・応答不正では旧Canvas画像を隠し、プレビュー・旧index-path編集を停止、再読み込みを明示。旧表示状態でPython合成を自動実行しない。
- 有効なキャンバス内ピクセルレイヤーのPNGまたは矩形が欠落した場合、部分欠落を無視せずPythonへフォールバック。空・範囲外のピクセルレイヤーは両方nullを許容し、グループの画像混入は拒否。Playwrightで実際のフォールバックAPI呼び出しを確認。

- Canvas素材の取得中にPSDが外部で差し替わり、素材APIが400で失敗する場合は、旧index-pathのPython送信をゼロにし、プレビューを隠して再読み込みを要求する。Pythonフォールバックにはfull stat識別子を添え、同一size/mtimeのinode差し替えをバックエンドでも拒否する。
- 1000×1000 PSD・900×900 Canvas・bbox [5,0,15,10] など0.5境界を含む合成ケースで、Pythonの縮小矩形とJavaScriptの検証矩形が一致し、Canvas経路を維持する。

## Issue #53 — レイヤーのOpen役割ワンクリック切替（UI Slice 1）

- PSDレイヤーの基本ON/OFF用チェックと、Open役割の「なし／閉／開」ボタンは別操作。役割ボタンの変更だけではbaseの表示状態を変更しない。
- 役割変更と解除、選択状態（aria-pressed）、キーボードEnter操作をPlaywrightで確認。検索・階層開閉・非表示親・元PSDと同名index-path識別、旧custom設定の無断消去、JSON保存・読み込み、CanvasとPythonのプレビュー経路を回帰テスト。
- 目・aiueoや自動排他割当は実装しない。動画・音声・OTIOの出力処理は変更しない。
- Mac実PSDでの見つけやすさ、クリック回数、誤操作のしにくさ、画面幅による崩れをHuman評価。CI／独立コードレビュー／Human UXは別判定。

## Issue #53 — レイヤー選択・プレビュー範囲の視覚対応（UI Slice 2）

- レイヤー名のボタン選択はチェックボックスの基本表示、Open役割、保存するプリセットを変更しない。名前と基本表示をクリック領域として分離する。
- 同名のレイヤー・入れ子グループでもindex-pathで選択を識別し、選択行の強調とPSDキャンバスのbboxが一致することをPlaywrightで確認する。bboxが空、不正値、範囲外で面積ゼロなら描画しない。
- 選択は表示切替やサーバー再合成を起動しない。検索・階層折りたたみで選択行が非表示になっても、プレビュー側の範囲表示を維持し、再表示時に同じ行が選択される。
- プレビューの既存拡大・パン・Open状態変更時も選択範囲が画像と同じ座標変換で動き、選択位置拡大で中心に移動すること。新しいPSDの読込では選択を解除する。
- Mac実PSDの大きなレイヤーツリーでの見つけやすさ、視認性、押し間違い、拡大・パン時の位置一致はHuman UX別ゲート。Python・動画書き出し・OTIO・DaVinci Resolveの契約は変更しない。


## Public Issue #2 — PCM内包ProRes MOV、個別OTIO

- 合成のみで8/16/24/32-bit整数PCMのmono/stereoを検証。WAV 8-bit unsignedとMOV 8-bit signedの正規化後の全サンプル一致を判定。非対応チャンネル・形式は拒否する。
- WAVの冒頭・末尾無音、101/1000秒のような映像フレーム非整数尺、音声start=0、復号PCMの全バイト一致、音声の切詰め・付加なしを独立チェックする。
- 元の透過ProRes 4444映像を再エンコードせず、mux前後の映像パケットhash、codec/profile/pixel formatを照合する。元PSD/WAVを編集しない。
- 個別OTIOのVideoとAudioは同一MOVを参照し、Audioのsource_rangeは元WAVサンプル尺、Videoは切り上げフレーム尺とする。旧単独OTIO PoCのWAV参照は回帰維持する。多キャラ出力は本Issueでは追加しない。
- mux/デコード/検証失敗はMOV・OTIOを公開せず、既存の上書き・別名・部分失敗復旧の保証を回帰する。日本語/空白/NFDの入力WAV、出力フォルダを試す。
- mux前後の全映像パケットのSHA-256だけでなくPTS/DTS/durationが同一であることを確認し、中間フレーム時刻だけを改変する故障注入で公開を拒否する。
- WAV解析時の全PCM内容ハッシュをmux側と照合する。サンプル数・レート・形式が同一の外部WAV差替えをWeb/CLI両経路で故障注入し、MOV/OTIO未公開を確認する。
- CLIのOTIO失敗時は公開MOV名を先に復旧領域へ原子的に移し、他所有ファイルを削除しない。競合ファイル保全・同名再出力の拒否と通常のロールバック成功をテストする。
- **Mac実機ゲートは独立**：①PCM入りMOV単独をResolveへ読み込み音声再生、②個別OTIOを別タイムラインとして読み込んで音声トラックが再生、③各取り込みで無音・二重再生・同期ずれなし。**2026-11-06、Mac実PSD/WAVを使い①②③と編集操作（クリップ移動／トリミング）をHuman PASS確認**。CIの合成素材・独立コード監査とは別の結果。Windowsは未検証。
- **2026-11-06製品承認済み**：`PRODUCT_SPEC.md` §6とD16/D17はPCM内包MOV・同じMOVを参照する個別OTIOへ更新し、元WAVの出力コピー／同梱は不要と決定。複数キャラ・全体OTIOは別途未実装のため、1発話に音声内包MOVは最大1本（音声の二重再生なし）の契約を将来のテストで検証する。自動テストはResolveでの互換性証拠の代わりにならない。

## Issue #14 — Human UX統合修正（Draft PR #15）

- WAV一覧の左端ドラッグハンドル、行内再生・一時停止・シーク、全件連続再生・停止をPlaywrightで確認。元ファイル不変、Blob解放、異常系は引き続き自動テスト。
- 書き出し操作を1つのパネルに統合し、1件／全件の切替、一覧内のnone/open表示、口パクなし件数、明示的な「全件に適用」を確認する。個別設定の無断変更は禁止。
- 合成プリセットのopen割当と2 WAVから、同じ項目・同じ設定について個別／全件が**同一のAPIペイロード**を送信することを検証。レンダリングバックエンドのPCM/MOV/OTIO経路は既存テストを再利用し、Mac Humanには画面の使い勝手だけを評価してもらう。
