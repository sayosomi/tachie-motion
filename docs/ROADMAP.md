# Roadmap

**現在の状態：Phase 0とPhase 1のCLI、およびmainの統合プリセット編集・Mac Finder選択・単一WAVのnone/open書き出しは実装済み。新規・上書き・別名保存とDaVinci Resolveの透過・口パク・音声同期は2026年11月1日にMac Human PASS。aiueoの6口形レイヤー編集・静止プレビューはmainで対応済み。LAB駆動aiueoのMOV生成はIssue #27 / PR #28でmainへ統合済み（当時の個別OTIOは旧仕様）。**現行の製品Web UIでは単一書き出しがPCM内包MOVのみ、一括書き出しがMOV群＋全体OTIO 1本で、個別OTIOは生成しない（Issue #38 / PR #39、2026-11-19 main統合）。**CI・独立監査・Mac実機の書き出し／口パク表示／Resolve OTIO読み込みを確認済み。単一キャラクターの瞬き付きセリフMOV（Issue #34 / PR #35）は実装済み・CI／コード監査／Mac実PSD・DaVinci ResolveのHuman確認PASS。変更点タイムライン・複数キャラクター・待機モーションは未実装。制作プロジェクトJSON保存・復元、単一キャラ全体OTIOはPR #17・#19で実装済み。キャラクター設定JSONの独立保存・読み込みは既存機能として実装済み。JSON往復の自動テストとMac Chrome保存UIのHuman UXはPASS。**

この文書は実装の進捗と今後の作業範囲を示します。確定した製品要件は [PRODUCT_SPEC.md](PRODUCT_SPEC.md)、実際に使えるコマンドは [README.md](../README.md) を参照してください。PoCで確認したことと、完成したアプリでできることは区別します。

## Public Issue #51 — プリセット名の自動確定と名前変更ボタン廃止（PR #52、2026-11-20受け入れ）

- [x] 詳細画面で名前入力欄からフォーカスが外れると自動確定し、専用の「名前を変更」ボタンを廃止。IME変換中のEnterでは誤確定しない。空欄・重複・保存失敗は確定名と入力途中の文字列を保護し、入力欄近くに理由を表示。保存エラー時は一覧へ戻る操作で理由を消さず編集画面に留める。
- [x] trim後の同名ではプリセット本体の更新を避け、必要な下書き整理のみ行う。空白入力仕様をTEST_PLANと統一。ブラウザ復元・安定ID・キャラクター設定JSON・保存失敗・直接一覧クリックをPlaywrightで回帰確認。Mac実PSDでの通常の名前編集Human UXは2026-11-20 PASS（エラー後の直接一覧クリック操作は自動テストで確認）。
- [x] 独立ブロッキング差分再監査はexact HEAD `5877cc48c1966465be04be92dcacd1d8e910812d` で**PASS（HIGH 0 / MEDIUM 0 / LOW 2）**。旧MEDIUM-01・LOW-01/02は解消。非ブロッキングLOW 2件（確定名に完全一致する入力への戻しで下書きが残る、no-op後のdirty不変確認不足）は今後の改善候補とし、完了を妨げない。GitHub ActionsのPython PoC tests・Phase 1 local Web UIは同HEADでSUCCESS、Web UI Playwright **201/201 PASS**。この完了記録だけの追加コミットでは製品コード・テストを変更しない。PSD/MOV/OTIO経路の変更なし。

## Public Issue #53 — プレビューのホイール倍率を連続化（PR #54、2026-11-20受け入れ）

- [x] PR #54でホイール倍率を固定段階から移動量比例の連続倍率へ変更。ポインタ基準の1〜8倍、＋／−ボタンの段階操作、サムネイル明示保存を維持。
- [x] Mac実PSDでの見た目・操作性は2026-11-20 Human PASS。Mac Frontend Build PASS、Playwright `thumbnail.spec.ts` は最新製品コードで10/10 PASS。
- [x] 独立差分再監査（exact HEAD `e50988e0e29b166b1356bc3b1e93bd6e25b66a27`）はHIGH 0 / MEDIUM 0 / LOW 0でPASS。旧MEDIUM-01・LOW-01は解消。GitHub ActionsのPython PoC tests、Phase 1 local Web UIは同HEADでSUCCESS（Web UI CI Playwright 197/197）。この最後のROADMAP更新では製品コードとテストを変更しない。PSD/MOV/OTIO描画経路は変更なし。

## Public Issue #44 — 書き出し進捗オーバーレイと安全なキャンセル（PR #45、2026-11-19 main統合）

- [x] 個別／一括の両方で元画面全体を暗く覆い、中央に大きな％・進捗バー・対象WAV・処理段階を表示。Esc／外側クリックは不可。完了・失敗・キャンセル確定後に閉じる。
- [x] PythonとFastAPIに実進捗・トークン保護・協調キャンセルを追加。フレーム送信・ProRes独立検証・PCM結合・一括OTIO公開を区別し、検証・公開前に100%を示さない。
- [x] キャンセル時も既存MOV／OTIOと元PSD/WAV/LABを保護。一括の最終公開開始後はキャンセルを拒否し、公開トランザクション・復旧を中断しない。
- [x] Python実FFmpegテスト、Playwright E2E（191/191）、Python 3.12/3.14・OpenTimelineIO CI、独立コード差分監査（HIGH/MEDIUM解消・文書LOW修正）、Mac実PSD/WAVでの全画面表示・進捗更新・キャンセル操作Human UXを別々にPASS確認。**2026-11-19 PR #45 main統合、Issue #44クローズ。** DaVinci Resolveでの今回のHumanおよび強制終了後のMac手動復旧は未実施であり、PASS扱いしない。

## Public Issue #42 — プリセット別サムネイル編集とWAV画像選択（PR #43、2026-11-19受け入れ）

- [x] 既存プレビューを4:3に固定し、＋／−・ドラッグ・矢印キーとポインタ基準のホイール拡大縮小で構図を調整し、「サムネにする」で明示保存。一覧・WAVの画像付き候補で同じ4:3を再現。専用編集画面は設けず、PSD・MOVのレンダリング座標は変更しない。
- [x] キャラクター設定JSON／制作プロジェクトのキャラクタースナップショット／ブラウザ復元で往復し、不正・非有限値を拒否。画像本体は保存しない。
- [x] Playwright 186/186、Python 3.12/3.14/OTIO CI、独立コード監査（HIGH 0/MEDIUM 0/LOW 0）、Mac実PSDでの4:3・サムネ保存・ホイール操作Human UXをそれぞれPASS。CIの低速APTミラー由来の20分キャンセルはPR #43内のワークフロー変更で解消。DaVinci Resolve再検証は描画・書き出し変更がないため実施しない。

## Public Issue #40 — 末尾 `pau` のWAV尺超過補正（PR #41、2026-11-19受け入れ）

- [x] 読み込みと書き出し再検査で、最終区間が無音 `pau` のときだけWAVの整数サンプル尺に合わせて区間終端をメモリ内で切り詰める。実素材015番の約14.5 ms超過を受け入れるが、元のWAV/LABは変更せず、途中区間や発声音素は補正しない。
- [x] 合成WAV/LABの正常系・異常系・整数tick境界・原本不変・aiueo口形を自動検証。Python 3.12/3.14各411件・ProRes各4件・OTIO 5件のCI PASS、独立差分監査PASS（HIGH 0/MEDIUM 0/LOW 2）。Mac実素材015番のLAB有効・aiueo選択、MOV生成とResolveでの映像・音声・透過確認を利用者がHuman PASS。補正ケース固有のAPI→MOV統合テスト拡充は非ブロッキングで残る。
- [x] PR #39の独立監査PASS HEADを改変せず、PR #39をmainへ先行統合（merge commit `197595ff`）。PR #41はmainへbaseを変更し、独立した末尾pauの変更のみを残す。

## Phase 0 — feasibility proof of concept：完了

- [x] PSDの元レイヤー階層・順序・名前・可視状態を読み出す（インデックスパスで識別）。
- [x] 手動指定したレイヤーを表示／非表示にして、変更した状態をPNGに合成する。元PSDは変更しない。
- [x] 非表示レイヤーを含めた固定透過クロップ候補と基準位置を求め、複数状態に適用する。
- [x] RGBA PNG状態からProRes 4444透過MOVを生成し、全フレームを復号して画質・透過・領域破損を検査する。
- [x] MOV 1本とWAV 1本の同期した個別OTIOを生成し、DaVinci Resolveで基本的な透過・再生・シーク・同期を人間が確認する。
- [x] PSDの合成互換性リスクを検出する診断用CLIと、独立した自動テストを用意する。

**完了の証拠：** Phase 0 PR #2（旧Private開発履歴）（関連 Issue #1（旧Private開発履歴））。Phase 0の完了はWeb UIや音量連動口パクが利用できることを意味しません。

### Phase 0後の性能改善：実装済み

- [x] ProRes生成後の重複検査の削減、既存の全フレーム品質保証は維持 — Issue #4（旧Private開発履歴） / PR #5（旧Private開発履歴）。
- [x] 新規MOVの品質検証結果を同期OTIO生成時に再利用し、同一MOVを再スキャンしない結合経路 — Issue #6（旧Private開発履歴） / PR #7（旧Private開発履歴）。外部MOVの独立検証は継続。
- [x] ProResの同一保持フレームを圧縮済みパケットで再利用する**明示的オプトイン**。不適用時は従来経路へ戻し、全フレーム品質検査を維持 — Issue #8（旧Private開発履歴） / PR #9（旧Private開発履歴）。
- [ ] エンドツーエンドで残る処理時間の継続調査・優先順位整理 — 性能調査Issue #3（旧Private開発履歴）（OPEN）。既存の最適化成果と今後の調査を区別する。

### Public Issue #2 — PCM内包セリフMOV（PR #10 main統合済み・Mac Resolve Human PASS）

- [x] 既存の単一WAV/キャラクターMOV書き出しに、映像ストリームをコピーしたPCM内包処理を追加（試験実装）。
- [x] 合成PCM（8/16/24/32-bit、mono/stereo）の復号サンプル一致、映像パケット一致、映像の端数丸めと音声サンプル長の独立性を検証する自動テストを追加。
- [x] 2026-11-06 Mac実PSD/WAVで**単独MOV取り込み**の透過映像と音声再生をHuman PASS確認。
- [x] 2026-11-06 Mac実PSD/WAVで**個別OTIO取り込み**の音声トラック・音声欠落／二重再生なし・同期、クリップ移動／トリミングをHuman PASS確認。
- [x] 2026-11-06利用者承認に基づき `PRODUCT_SPEC.md` §6と`DECISIONS.md` D16/D17を正式更新。【2026-11-06当時の仕様】非圧縮PCM入りMOVと同一MOV参照の個別OTIOを正本としていた（Issue #38で個別OTIOを廃止）。WAVコピー機能は現在も設けない。

PR #10は2026-11-06にマージ済み。1 WAV・1キャラクターのPCM入りMOVと個別OTIOはMac Resolve実機検証済み。複数WAVの逐次一括書き出しはIssue #4 / PR #13・Issue #14 / PR #15で実装済み。複数キャラクターは未実装。単一キャラの全体OTIOはIssue #18 / PR #19で実装済み。正式仕様の詳細は [PRODUCT_SPEC](PRODUCT_SPEC.md) §6と [DECISIONS](DECISIONS.md) D16/D17を参照。

## Phase 1 — first usable single-character tool：CLI・Web UI初期版をmainに統合済み

- [x] WAV PCMの音量解析と決定論的な開閉フレーム列JSON CLI — Issue #12（旧Private開発履歴）（Phase 1 Slice 1。PSD・MOV・OTIO接続は未実装）。
- [x] 口閉／口開の2 PSDレイヤーを**人間が指定**し、1キャラクター＋1 WAVから透過MOVと個別同期OTIOを生成する内部処理・CLI — Issue #14（旧Private開発履歴）。目・表情・ポーズ・瞬きの設定UIおよび高度な口形は未実装。
- [x] 日本語・結合文字を含む元WAVを複製せず、絶対パスで参照する個別OTIOのResolve互換性調整 — Issue #16（旧Private開発履歴） / PR #17（旧Private開発履歴）。2026-10-30に実WAVと個別OTIOのオンライン・同期をMac ResolveでHuman PASS。
- [x] 最小ローカルWeb UIと旧試験版APIの基盤 — Issue #18（旧Private開発履歴） / PR #19（旧Private開発履歴）。旧試験版タブは後続PR #38で廃止し、APIは互換性のため維持。現行のプリセット基準「セリフ」画面でMac Human E2Eを確認済み。
- [x] PSDツリー開閉、手動口・目割当、割当解除と静止画プレビュー — Issue #21（旧Private開発履歴） / PR #22（旧Private開発履歴）。瞬きMOVは未実装。
- [x] **Mac FinderからのPSD/WAV/出力先選択** — Issue #20（旧Private開発履歴） / PR #39（旧Private開発履歴）。Mac Finder操作Human PASS、後続の正確なPR #39 HEADでブラウザ・Python CI SUCCESS。専用127.0.0.1:8766でOS選択を隔離し、直接パス入力は補助。ドラッグ＆ドロップとWindows Explorer連携は未実装。Android遠隔からFinderは使用不可。
- [x] **キャラクター設定だけ**のバージョン付きJSON保存・読み込み（既存機能、JSON往復の自動テストとMac Chrome保存ダイアログUXがPASS）。ブラウザ標準保存ダイアログ／ファイル選択でプリセットID・並び順・Open等の設定を保持し、元PSDのパス・fingerprint・レイヤーパス一致を確認してから反映。制作プロジェクト保存・PSDの移動先再関連付けは未実装。
- [ ] 上記のCLIとUIで共通の処理を使う自動テスト、およびmacOS/Windowsの必要な実機確認。

**注意：** `tachie-prores-poc` は固定保持PNG状態用のPoCで、音量連動は `tachie-mouth-render` と新「セリフ」画面のopenが担当します。旧試験版タブは廃止済み、旧 `/api/export` は互換性のため残します。編集タイムラインや制作プロジェクト保存は未実装。キャラクターJSONの保存・読み込みは既存の別操作。

### Android接続の起動信頼性（Issue #29）

- [x] 単一のフォアグラウンドコマンドでMac Web 8765／Tailscale HTTPS 8443を管理し、両方のヘルス確認後のみREADYを表示 — Issue #29（旧Private開発履歴） / PR #30（旧Private開発履歴）。既存Voiceger 443を保護し、Funnel・常駐なし。後続PR #34のAndroid Chrome実機操作はHuman PASS。すべてのServe停止・再起動条件のHuman網羅は未確認。

## Phase 2 — animation editor：統合プリセットWeb UI初期版は実装済み、変更点タイムラインは未実装

- [x] 統合プリセットの内部データモデル — Issue #25（旧Private開発履歴） / PR #26（旧Private開発履歴）。ブラウザUIは後続のPR #28で実装、永続的JSON保存は未実装。

- [x] プリセット一覧・詳細編集、レイヤーON/OFF・静止PSD合成プレビュー — Issue #27（旧Private開発履歴） / PR #28（旧Private開発履歴）。ブラウザ限定の自動復元はPR #32で追加。口のopen動画出力はPR #38で実装。プロファイルJSON保存は既存機能として実装、目の瞬きMOVは未実装。
- [ ] 表情＋ポーズ**統合プリセット**の管理画面（一覧／詳細ページ、サムネイル、作成・独立複製・名前変更・削除・ドラッグ＆ドロップ並び替え）と、各レイヤーのON/OFF・永続保存 — Issue #23（旧Private開発履歴）。
- [ ] 1プリセットに独立して登録できるopen（閉口／開口）とaiueo（あ・い・う・え・お・ん）の**両**口形セット、複数レイヤーで構成する口・目状態、プレビューとレンダラーの一貫性 — Issue #23（旧Private開発履歴）。
- [x] **aiueoの6口形レイヤー編集と静止プレビュー** — Public Issue #23 / PR #24。Openと独立した6口形の保存・静止プレビューを実装。旧「ここだけ」UIはHuman UX未PASSのため、後続Issue #25 / PR #26のPSDグループ割当UIに置き換えた。LAB駆動aiueo MOV/OTIOはPublic Issue #27 / PR #28で実装。目・瞬きのアニメーションは未実装。
- [x] **PSDレイヤーグループによる動作対象管理と通常レイヤーの分離** — Public Issue #25 / PR #26。元PSDグループの複数割当、通常レイヤーと口形編集の分離、Open/aiueo独立、プリセット単位の口パクOFF、`*` 同親グループ排他ラジオと `!` 強制表示、未設定プレビューと拡大に対応。旧JSON・ブラウザ復元・制作プロジェクトの参照とレイヤー制約を検証し、不正データは保持して復元を拒否。2026-11-17 Mac Human UX PASS、独立ブロッキング監査 PASS（HIGH 0 / MEDIUM 0 / LOW 0、監査対象コードHEAD `423129e`）。aiueo動画生成はPublic Issue #27 / PR #28にて実装済み。瞬きUI・レンダリングは後続Issueの対象。
- [x] **LAB検出・形式／時刻検証のPython基盤（Public Issue #21）** — WAVと同名隣接のLABを元のUnicode名のまま読み取り、VOICEVOX/OpenJTalkの既知音素と整数100ns時刻をWAVサンプル尺に照らして検証。不在・不正を区別し、未知音素・重複／逆転時刻・WAV/LAB変更や危険なファイルを拒否。これは内部パーサと合成素材テストだけであり、aiueo選択UI・口形フレーム生成・MOV書き出しは上の未実装項目に残る。
- [x] **LAB連動aiueoのセリフMOV・OTIO（Public Issue #27 / PR #28）** — WAVと同名LABの状態を一覧表示し、承認済みD27のフレーム中央・次母音先取り・無声化母音規則で6口形を駆動。【当時の旧仕様】休止口「ん」は未設定なら基本表示を継承していたが、Issue #32で廃止し、現在は「ん」も明示選択必須。個別／一括のPCM内包ProRes MOV・OTIOと制作プロジェクトJSON v2へ接続。WAV/LAB識別子、最終公開前のLAB再検査、PSDTool制約と元素材の保護を自動テスト。最終コードHEAD `387c95f2` のPython/Web UI CIはSUCCESS、独立差分監査PASS（HIGH 0 / MEDIUM 0 / LOW 2）。2026-11-17 Mac実素材で一括MOV・aiueo口パク表示・DaVinci ResolveのOTIO読み込みを利用者がPASS確認。音声のサンプル単位の同期精度や実素材透過画素の厳密照合は今回のHuman報告では未確認。後続の非ブロッキング品質強化はIssue #29。
- [ ] 安定したプリセットIDを参照する変更点タイムライン。
- [x] **目のclose編集と静止プレビュー（Public Issue #32 / PR #33）** — A案のタブUIに統一。「固定レイヤー／可動レイヤー」、可動側の「口／目」、口の「Open／aiueo」、6母音の文字ボタンを使う。各動作のON/OFFはチェックボックス1つ。可動レイヤーの選択操作は対象グループ→対象レイヤーの2段階（未選択時は検索・一覧を非表示）。固定・可動の両方で行クリックから表示状態を直接編集し、PCのプレビューはページスクロールに追従。「ん」を含む6口形は明示選択が必要で、未選択なら口・閉じ目の編集可能な葉はプレビュー非表示。固定レイヤーが口close・目openの唯一の基準であり、可動側はOpen-open・aiueoの6口形・目closeを編集する。旧形式の互換読み込みを廃止し、キャラクターJSON v2・プロジェクトJSON v3・ブラウザ復元v2で区別。通常時／動作時プレビューとOpen MOVの閉口フレームで固定状態を共用。PSDTool制約・グループ競合・保存復元・FFmpeg出力を回帰させない。瞬きMOV／間隔は未実装。旧コードHEAD `b0f29cb5` におけるCI・監査履歴はPASS。後続HEAD `42ce7baf` は独立監査BLOCKED（HIGH 0 / MEDIUM 2 / LOW 1）。さらに `1073c41a` は閉じ目解除後のJSON不整合とWeb UI CIのAPT取得タイムアウトによりBLOCKED（HIGH 0 / MEDIUM 2 / LOW 1）。最終実装HEAD `36a6ea47` は独立差分監査PASS（HIGH 0 / MEDIUM 0 / LOW 1、非ブロッキング）。Web UI CIはPlaywright 152/152、Python CIは3.12・3.14・OTIO 3.13でPASS。2026-11-18 Mac実PSDで行クリック・解除・固定と同じ葉の明示選択・スクロール追従プレビューのHuman UXをPASS確認。目の瞬きMOVは未実装で、後続開発に残す。
- [x] **瞬き付きセリフMOV（Public Issue #34 / PR #35、完了）** — Issue #32 / PR #33で目の固定開眼・可動閉眼の編集と静止プレビューは完成済み。整数フレームの決定論的スケジューラ、閉眼PSD状態の検証、口パク「なし／open／aiueo」との複合状態を生成するバックエンドAPI経路と合成素材テストを実装済み。**PR #35で、キャラ共通の時間設定UI（間隔・閉眼時間・揺らぎ・初回位相の秒指定と固定seed）とブラウザ・キャラクター／プロジェクトJSONへの保存、瞬きの書き出し許可、個別／一括APIの連携を追加済み。UXフィードバックを受け、初期値（3秒・0.12秒・±0.5秒・初回0.7秒・seed 0）を正式なキャラ共通の**保存済み初期設定**に変更。新規PSD・時間未設定の現行形式ブラウザ復元／キャラクターJSON／制作プロジェクトで永続化後に表示し、既存調整値を保護する。ユーザーによる変更だけ明示保存する。閉じ目の*葉選択では同一対象グループ内の*兄弟PSDグループを閉眼時だけ排他的に隠す。編集中のエラーはスクロールに依らない固定通知に変更。Mac Humanで一括書き出しの汎用エラーが011番の原因を示せない問題が見つかったため、既存の受理条件を変えずにWAV番号・具体的な口形/LAB/瞬き不足を事前表示する修正と回帰テストを追加。最終HEADのWeb UI / Playwright 168/168、Python 3.12／3.14、公式OTIOのCIと独立差分監査（HIGH 0／MEDIUM 0／LOW 2）はPASS。2026-11-18にMac実PSDで生成した瞬きMOVの視覚動作とDaVinci ResolveへのMOV／OTIO取り込み、透過、内包音声再生、音声の二重再生なしをHuman PASS確認。CI・独立監査・実機検証は別ゲートとして合格判定した。
- [x] **セリフMOVの発話／書き出しごとの瞬きランダム化（Public Issue #36 / PR #37、完了）** — Issue #34で完成した固定シードによる同時刻パターンを廃止し、書き出し単位の新しい乱数で初回目安±揺らぎと平均間隔±揺らぎを計算する。再書き出し時の再現性は不要。ユーザー向けシード入力を撤去し、既存JSONのseedフィールドは読込を保ちながら生成時には無視する。平均間隔・閉眼幅・fps・元PSD／WAV／LAB保護・PCM内包・OTIO契約は維持。合成MOVとUIの回帰テスト、Web UI Playwright 168/168・Python 3.12/3.14・公式OTIOの全CI、独立コード監査（HIGH 0 / MEDIUM 0 / LOW 2）はPASS。2026-11-19、Mac実PSDでの発話／再書き出しごとの瞬きの自然なばらつきを利用者がHuman PASS確認。
- [x] **単一セリフのPCM内包MOVのみ書き出し（Public Issue #38 / PR #39、2026-11-19 main統合・Mac Human PASS）** — 利用者決定により個別OTIOを廃止。単一はMOVのみ、一括は各MOV＋全体OTIO 1本を維持する。単一・一括MOV共通の初期命名を `{番号}_{キャラ名}_{WAV名}` とし、連番が既にある元WAVも無加工で保持。単一は一覧順やテンプレート変更に連動する自動名と、個別に固定する手動名を区別。日本語・空白・NFDを許容する。既存OTIOを削除せず、同じ出力フォルダに他の全体OTIOを含むOTIOがあるときは既存MOVの単独上書きを保守的に拒否して別名保存へ誘導する。一括復旧領域が残るフォルダは別名探索せず使用停止し、復旧状態を表示する。MOV単体の上書き／別名、PCM・透過・fps・出力先の安全性を回帰テストし、CI・独立監査・Mac Humanを別ゲートで判定する。競合する第三者ファイルを削除しないため、Mac/Linuxの原子的非置換renameで旧MOVを隔離し、上書き後の旧MOV履歴は手動整理まで保持する。履歴分のディスク容量が必要であることをREADMEに明記する。
- [x] **WAV再生行の波形表示とクリック／ドラッグによるシーク（Public Issue #47 / PR #48）** — 既存の試聴WAVをブラウザ内で最大180列の簡易波形として表示し、クリック／ドラッグによるシークとネイティブrangeを両立。WAV Blob 16MiB超、推定デコードPCM 24MiB超、Web Audio非対応・解析失敗時は波形のみ省略して既存スライダーを維持。解析は同時1件に制限し、中断要求・古い結果の破棄を実装。Macの大文字・小文字を区別しないファイルシステムで生じたTS1192/TS1149は解析モジュール名変更とビルド時のモジュール名衝突チェックで対処。HEAD `93f8bbb` のWeb UI CI（Playwright 195/195）、Python／OTIO CIと独立差分監査がPASS。2026-11-20 Mac実WAVでの起動・波形視認性・クリック／ドラッグの操作感はユーザー報告でHuman PASS。周期信号に対する簡易波形のサンプリング取りこぼしは非ブロッキング既知制限。元WAV／MOV／OTIO／制作プロジェクトJSONの形式・出力経路は変更なし。変更点タイムラインは未実装。
- [ ] **WAV波形連動のプリセット変更点（Public Issue #49 / Draft PR #50、実装中）** — PCM整数サンプル基準の初期データモデルは独立監査PASS（HIGH 0／MEDIUM 0／LOW 1）。変更点編集UI・制作プロジェクトJSON v4・単一／一括MOVへの反映はPR #50で接続作業中。旧WAV/PSD/LAB不変、書き出し結果の旧仕様保護と固定キャンバスを維持する。Mac HumanとDaVinci Resolveは未実施。完了と誤記しない。

- [x] **PCファースト**の横長プリセットカードと重なり回帰対策 — Issue #35（旧Private開発履歴） / PR #37（旧Private開発履歴）。現行の新「セリフ」画面（1 WAV、none/open）は Issue #36（旧Private開発履歴） / PR #38（旧Private開発履歴）で実装。Mac実PSD/WAV→Resolve Human PASSは後続PR #43で確認。
- [x] Android実機フィードバックのUI改善と**ブラウザ限定の自動復元** — Issue #31（旧Private開発履歴） / PR #32（旧Private開発履歴）。PSD fingerprint検証付き復元、プリセットの名前重複防止、PCドラッグ取っ手＋スマホ↑↓、見出し簡素化。キャラクター設定のJSONファイル保存・読み込みは既存機能として実装済み。保存はChrome/Edgeの標準保存ダイアログ（保存名・場所を選択）を使用し、非対応ブラウザでは自動ダウンロードせずエラー。Mac Chromeで保存先・名前指定、保存通知、キャンセル操作のHuman UX PASS。JSON内容・復元の一致はPlaywrightで自動検証。

### レイヤー選択UIの改善（Issue #53、作業中）

- [x] **Open役割をワンクリックの「なし／閉／開」ボタン化** — PR #57（旧Private開発履歴） でmain統合済み。Web UI・Python CI、独立ブロッキング監査、Mac実PSDでの操作性Human評価PASS（2026-11-05）。基本ON/OFF・特殊割当を保持。
- [x] **レイヤー名の選択とプレビューの範囲強調** — PR #58（旧Private開発履歴） で実装。チェックによる基本表示とレイヤー名による選択を分離し、index-pathとPSD上のbboxで即時フィードバック。Web UI・Python CI、独立ブロッキングレビュー、Mac実PSD Human UXをそれぞれPASS（2026-11-05〜06）。 後続のPublic Issue #25 / Draft PR #26では、水色の選択枠線を廃止し、レイヤー選択と「選択位置へ」の拡大機能は維持する。
- [ ] さらに必要な行選択操作・排他グループ等はHuman UX結果に基づき判断。PSDレイヤー名から関係を推測する機能は無断導入しない。

## Phase 3 — workflow integration：複数WAVの項目別編集から着手

- [x] **複数WAVの登録・選択・並べ替え・一覧削除と項目別の個別書き出し** — Public Issue #4。安定IDで元パス（同一ファイルの複数登録・同名別パス・Unicode NFDを含む）、解析結果、プリセット、口パク方式、fps、保存設定を独立管理。【PR #13当時の仕様】選択した1項目にPCM入りMOV＋個別OTIOを書き出していた。現在はIssue #38で個別OTIOを生成しない。セリフ画面とプリセット画面の往復中は一覧を保持するが、正式な制作プロジェクト保存／再読み込み復元は未実装。PR #13で実装し、PR #15とともにmainへ統合。
- [ ] 1 WAVから複数キャラクターMOV、聞き手のリアクション。
- [ ] 汎用ループ待機モーションと場面専用待機。
- [x] **複数WAVのFinder一括選択、ドラッグ並べ替え、個別／一覧順連続再生、1キャラ全件MOV＋個別OTIO書き出し（当時の旧仕様）** — Public Issue #14 / PR #15（PR #13基盤の後続変更）。【PR #15当時の仕様】単一キャラPCM入りMOV＋個別OTIO生成を逐次再利用していた。現在の一括はMOV群＋全体OTIO 1本であり、個別OTIOは生成しない。当時は衝突事前検証・既存ペア上書きの明示確認・部分失敗結果・元素材不変を維持。Mac Humanフィードバック（11/7）：再生ボタンをWAV各行へ、ドラッグ取っ手を左端へ移動し、単体・全件を同じ書き出しパネルへ統合。各WAVの口パク初期値「なし」を明示し、プリセット・方式の全件適用は確認付き操作とする。個別／全件のレンダリングAPI要求構築は共有し、同一入力設定の出力を回帰テストで照合。2026-11-09のMac Human UXは一覧操作・試聴・統合書き出し・口パク一致までPASS。追加フィードバックにより、WAV行のプリセット・口パク方式をそれぞれ直接選べるプルダウンへ変更し、表記は「なし／open」に統一、デスクトップ横幅も拡張（2026-11-10 Mac Human全件PASS）。続いて不要な「選択中のWAV」セクションを撤去し、全件適用操作をWAV一覧へ、口パク・瞬きの警告を書き出しパネルへ移動。書き出しパネルを全幅配置に変更。2026-11-10の最終2セクション画面（全件適用・警告・選択WAVの明確さ）もMac Human UX PASS。独立レビューはHIGH 0 / MEDIUM 0 / LOW 2でPASS、LOWは非ブロッキング。CI・独立レビュー・Mac Human UXは別ゲートとして検証済み。
- [x] **制作プロジェクトJSON保存・復元** — Public Issue #16 / PR #17（2026-11-16完成）。単一キャラ・複数WAVの順序・安定ID・プリセット・口パク／fps／出力設定を独立したバージョン付きJSONに保存。PSD／WAV参照とWAVのファイル同一性を復元時および書き出し前・公開直前に確認し、参照切れはFinder再指定、同一パスの変更は明示承認を要求。旧編集状態の部分置換とプロジェクト操作・書き出し競合を防止。独立監査 HIGH 0／MEDIUM 0、Mac実PSD・WAV 3件の保存・リロード・再指定・復元Human UX PASS。合成素材のPython CI／Playwright／OpenTimelineIOは最終製品コードHEADでPASS。全体OTIOを含む制作一括書き出しはPR #19で実装済み。
- [x] **一括上書きの別OTIO参照保護を事前表示（Public Issue #20 / PR #30、2026-11-18 main統合済み）** — 同じフォルダに他OTIOがあり、既存MOVを上書きする場合、事前に日本語で別名保存／別フォルダを案内し開始ボタンを無効化する。サーバー開始時も同じ判定を再実行し、書き込み保護を維持。CIと独立監査PASS（HIGH 0 / MEDIUM 0 / LOW 1）。Mac Humanは警告表示のみ利用者確認、切替操作はPlaywright確認。別OTIOがあるだけで拒否する安全側の制限自体の改善はPublic Issue #31として保留。

- [x] **一括書き出しの命名テンプレートと単一キャラ全体OTIO 1本** — Public Issue #18 / PR #19（2026-11-16完成。Resolve読込フリーズはMOV参照パス修正で解消し、製品からの一括出力・全体OTIO取込をMac HumanでPASS確認。隣接PCMサンプル境界の実機聴取は未報告。main統合後の独立差分監査はHIGH 0／MEDIUM 0／LOW 2、PASS、LOWは非ブロッキング。CI Python 3.12/3.14各326件、公式OTIO 5件、Playwright 108件 PASS）。一括の全MOV＋全体OTIOを非公開ステージで生成・検証し、旧一式のバックアップと復旧マニフェストを保持して公開する。上書き・連番付き別名保存と公開時の競合保護を実装。独立監査でMEDIUM-N03（隔離後のinode照合からunlinkまでの競合）およびLOW-N02（TEST_PLAN旧記述）が検出されたため、**正常終了・取消・10分失効・異常終了を含めステージ自動削除を停止**。一時ステージには公開済みMOVのハードリンクも残り得るため、利用者による手動整理が必要。製品用の4プレースホルダー `{番号}` / `{WAV名}` / `{キャラ名}` / `{プロジェクト名}`、保存予定名の事前表示、生成済みMOVのPCMを1回参照する全体OTIO、JSON v2とv1移行を含む。【PR #19当時】個別はMOV＋個別OTIO、一括はMOV群＋全体OTIOのみ。**現行のIssue #38では個別はMOVのみ**、一括はMOV群＋全体OTIO 1本で、個別OTIOは生成しない。複数キャラトラックは後続。
- [ ] **変更した項目だけ再生成**する管理、安定したメディア参照パス、全体OTIOを含む完全な制作プロジェクト一括出力。
- [ ] 全体OTIOにおける複数発話・複数キャラの配置、単一音声所有MOVの割当、トラックとギャップの検証。**WAVコピー／同梱機能は設けない**。

## Phase 4 — quality, distribution and OSS preparation：計画

- [x] **安全な単一ピクセルレイヤー変更のROI部分合成** — Issue #47（旧Private開発履歴） / PR #50（旧Private開発履歴）。初回読込のRGBAを最大1状態・32MiB保持し、40%未満の変更矩形だけを合成。特殊レイヤー・不適用条件・ROI異常は従来の全面合成へフォールバック。Mac M1実PSD（1500×3300px・85レイヤー）のサーバー内関数検証で、初回2.688秒、新規単一レイヤー状態0.361秒、参照の全面合成単体1.913秒。実際にROI経路が呼ばれ、RGBA全画素・縮小後・PNG復号後とPNG画像データ（IDAT）が一致、ICCは作成日時以外一致、PSD原本不変。Python CI・Web UI CI・独立コード監査は検証済み。ただし**API通信・ブラウザ描画・デバウンスを含む体感速度、通常運用の最大RSSは未測定**で、初回の全面合成は短縮していない。
- [x] **ブラウザ側Canvasレイヤー合成の製品統合** — Issue #55（旧Private開発履歴） / PR #56（旧Private開発履歴）。対応PSDのプリセット一覧・詳細・Openプレビューをブラウザで合成し、毎回のサーバー再合成を回避。未対応PSDや素材準備失敗時はPSD同一性を検証してからPythonへフォールバックする。Python・Web UI CIと独立ブロッキング監査PASS。2026年11月3日にMac実PSDでレイヤー切替の体感速度改善をHuman確認。画質の厳密な比較・ブラウザ描画時間の定量計測は未実施。元PSD・MOV/OTIO・レイヤーUI Issue #53は変更しない。
- [ ] PSD合成の互換性改善、実素材での性能分析、さらなる描画高速化。**同一状態の反復表示PNGキャッシュは実装済み** — Issue #47（旧Private開発履歴） / PR #48（旧Private開発履歴）。初回全面合成約2秒の短縮と、ROI適用外の複雑なPSDや複数変更時の高速化は未解決。ROIの基礎性能は PR #49（旧Private開発履歴） の読み取り専用プローブで検証し、安全な限定条件だけ PR #50（旧Private開発履歴） に実装した。一般化には別素材・ブラウザ経路の計測が必要で、Issue #47を継続する。
- [ ] エラーメッセージ、診断、ローカルWeb APIの安全性検証。
- [ ] macOS/Windows向け起動・配布体験、将来的なLinux対応。
- [ ] サンプル素材の権利確認、依存ライセンス監査、OSSライセンス決定。
- [ ] 対応編集ソフトとOTIO相互運用性の制限事項を文書化。

Phase 0の診断と限定的な性能改善が存在していても、Phase 4全体が実装済みであることは意味しません。進捗は実装された機能の範囲で判定します。

## 開発の進め方

PR #19〜#41の積み重ねPRは2026年11月1日に依存順でmainへ統合済みです。現行の利用手順は[README](../README.md)を正本とし、仕様の変更と未実装機能は[PRODUCT_SPEC](PRODUCT_SPEC.md)・[DECISIONS](DECISIONS.md)を参照します。新規コードのテスト、独立監査、Mac Human E2Eは別のゲートです。運用規則は[AGENTS.md](../AGENTS.md)に従います。


## Issue #40 — 同じPSDレイヤーツリーからOpen口形を指定（PR #41、main統合済み）

- [x] 既存プリセット詳細のPSD階層ツリーで基本ON/OFFとOpen役割を横並びに設定。PR #41時点のセレクトはIssue #53 / PR #57で「なし／閉／開」ボタンへ変更済み。階層・検索・割当済みのみ表示も維持。
- [x] 閉口・開口の1組を既存`openMouth`形式で保持し、以前の特殊な保存状態は無断破棄しない。
- [x] 元PSDのプレビューを基本／閉口／開口で比較する。PSD/WAV原本は変更しない。
- [x] PR #41のPlaywright/TypeScript・独立コード監査・Mac実PSDのプレビュー操作性をそれぞれ検証済み。
- [x] aiueoの6口形表示割当と静止プレビューはPublic Issue #23で実装。Open割当は保持。目・瞬きの役割列とOpen動作パラメータは後続実装で、セリフ項目側の別設計を維持。


- [x] 縦長PSDの全体表示と最大8倍拡大・ドラッグ移動・口元フォーカスをPR #41で修正。Mac実PSDで全体・口元・口形切替のHuman PASS（2026-11-01）。


## 【履歴：2026-11-01当時】Issue #42 — 個別MOV＋個別OTIOの上書き／別名書き出し（PR #43）

以下は過去の2ファイル同時公開の実装記録です。**現行Web UIは単一MOVのみ／一括MOV群＋全体OTIO 1本**で、この旧個別ペア上書きは使用しません。現行の挙動は上記のIssue #38および[README](../README.md)を参照してください。

- [x] 新「セリフ」画面でMOV・OTIO両方あり→上書き（既定）／別名、未使用名の提案と保存結果パスの表示。
- [x] 片割れ・symlink・復旧領域残存の同名書き出しを禁止。生成・検証後の排他的公開と通常失敗時の復旧を実装。二ファイルの完全原子性は保証しない。
- [x] 合成素材のAPI・競合・rollback・Playwrightのテストを実装し、最終exact HEADの独立コード監査PASS。Mac実PSD・WAVによる新規／上書き／別名とDaVinci Resolve透過・口パク・音声同期のHuman PASSを別途確認。最終HEADのGitHub Actionsは利用枠不足で未実施。
- [x] 旧試験版API・CLIの上書き拒否とPSD/WAV原本保護を維持。
