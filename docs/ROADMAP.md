# Roadmap

**現在の状態：Phase 0とPhase 1のCLI、およびmainの統合プリセット編集・Mac Finder選択・単一WAVのnone/open書き出しは実装済み。新規・上書き・別名保存とDaVinci Resolveの透過・口パク・音声同期は2026年11月1日にMac Human PASS。aiueo・瞬き・変更点タイムライン・複数キャラクター・制作プロジェクト保存は未実装。キャラクター設定JSONの独立保存・読み込みはIssue #44 / PR #45で実装済み。JSON往復の自動テストとMac Chrome保存UIのHuman UXはPASS。**

この文書は実装の進捗と今後の作業範囲を示します。確定した製品要件は [PRODUCT_SPEC.md](PRODUCT_SPEC.md)、実際に使えるコマンドは [README.md](../README.md) を参照してください。PoCで確認したことと、完成したアプリでできることは区別します。

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
- [x] 2026-11-06利用者承認に基づき `PRODUCT_SPEC.md` §6と`DECISIONS.md` D16/D17を正式更新。非圧縮PCM入りMOVと同一MOV参照の個別OTIOを正本とし、WAVコピー機能は設けない。

PR #10は2026-11-06にマージ済み。1 WAV・1キャラクターのPCM入りMOVと個別OTIOはMac Resolve実機検証済み。mainでは複数WAV・複数キャラ・全体OTIOの生成は未実装で（複数WAVはDraft PR #13・#15で実装中）、正式仕様の詳細は [PRODUCT_SPEC](PRODUCT_SPEC.md) §6と [DECISIONS](DECISIONS.md) D16/D17を参照。

## Phase 1 — first usable single-character tool：CLI・Web UI初期版をmainに統合済み

- [x] WAV PCMの音量解析と決定論的な開閉フレーム列JSON CLI — Issue #12（旧Private開発履歴）（Phase 1 Slice 1。PSD・MOV・OTIO接続は未実装）。
- [x] 口閉／口開の2 PSDレイヤーを**人間が指定**し、1キャラクター＋1 WAVから透過MOVと個別同期OTIOを生成する内部処理・CLI — Issue #14（旧Private開発履歴）。目・表情・ポーズ・瞬きの設定UIおよび高度な口形は未実装。
- [x] 日本語・結合文字を含む元WAVを複製せず、絶対パスで参照する個別OTIOのResolve互換性調整 — Issue #16（旧Private開発履歴） / PR #17（旧Private開発履歴）。2026-10-30に実WAVと個別OTIOのオンライン・同期をMac ResolveでHuman PASS。
- [x] 最小ローカルWeb UIと旧試験版APIの基盤 — Issue #18（旧Private開発履歴） / PR #19（旧Private開発履歴）。旧試験版タブは後続PR #38で廃止し、APIは互換性のため維持。現行のプリセット基準「セリフ」画面でMac Human E2Eを確認済み。
- [x] PSDツリー開閉、手動口・目割当、割当解除と静止画プレビュー — Issue #21（旧Private開発履歴） / PR #22（旧Private開発履歴）。瞬きMOVは未実装。
- [x] **Mac FinderからのPSD/WAV/出力先選択** — Issue #20（旧Private開発履歴） / PR #39（旧Private開発履歴）。Mac Finder操作Human PASS、後続の正確なPR #39 HEADでブラウザ・Python CI SUCCESS。専用127.0.0.1:8766でOS選択を隔離し、直接パス入力は補助。ドラッグ＆ドロップとWindows Explorer連携は未実装。Android遠隔からFinderは使用不可。
- [x] **キャラクター設定だけ**のバージョン付きJSON保存・読み込み（Issue #44 / PR #45、JSON往復の自動テストとMac Chrome保存ダイアログUXがPASS）。ブラウザ標準保存ダイアログ／ファイル選択でプリセットID・並び順・Open等の設定を保持し、元PSDのパス・fingerprint・レイヤーパス一致を確認してから反映。制作プロジェクト保存・PSDの移動先再関連付けは未実装。
- [ ] 上記のCLIとUIで共通の処理を使う自動テスト、およびmacOS/Windowsの必要な実機確認。

**注意：** `tachie-prores-poc` は固定保持PNG状態用のPoCで、音量連動は `tachie-mouth-render` と新「セリフ」画面のopenが担当します。旧試験版タブは廃止済み、旧 `/api/export` は互換性のため残します。編集タイムラインや制作プロジェクト保存は未実装。キャラクターJSONはIssue #44で追加した別操作。

### Android接続の起動信頼性（Issue #29）

- [x] 単一のフォアグラウンドコマンドでMac Web 8765／Tailscale HTTPS 8443を管理し、両方のヘルス確認後のみREADYを表示 — Issue #29（旧Private開発履歴） / PR #30（旧Private開発履歴）。既存Voiceger 443を保護し、Funnel・常駐なし。後続PR #34のAndroid Chrome実機操作はHuman PASS。すべてのServe停止・再起動条件のHuman網羅は未確認。

## Phase 2 — animation editor：統合プリセットWeb UI初期版は実装済み、変更点タイムラインは未実装

- [x] 統合プリセットの内部データモデル — Issue #25（旧Private開発履歴） / PR #26（旧Private開発履歴）。ブラウザUIは後続のPR #28で実装、永続的JSON保存は未実装。

- [x] プリセット一覧・詳細編集、レイヤーON/OFF・静止PSD合成プレビュー — Issue #27（旧Private開発履歴） / PR #28（旧Private開発履歴）。ブラウザ限定の自動復元はPR #32で追加。口のopen動画出力はPR #38で実装。プロファイルJSON保存はPR #45で実装、目の瞬きMOVは未実装。
- [ ] 表情＋ポーズ**統合プリセット**の管理画面（一覧／詳細ページ、サムネイル、作成・独立複製・名前変更・削除・ドラッグ＆ドロップ並び替え）と、各レイヤーのON/OFF・永続保存 — Issue #23（旧Private開発履歴）。
- [ ] 1プリセットに独立して登録できるopen（閉口／開口）とaiueo（あ・い・う・え・お・ん）の**両**口形セット、複数レイヤーで構成する口・目状態、プレビューとレンダラーの一貫性 — Issue #23（旧Private開発履歴）。
- [ ] WAVごとの使用口パク方式（なし／open／aiueo）、同名隣接LABの存在・形式・時刻検証、LAB不在／不正ならaiueo利用不可（自動フォールバックなし）。
- [ ] 安定したプリセットIDを参照する変更点タイムライン。
- [ ] 瞬き間隔、プリセットごとの無効化、再書き出しでも再現可能な揺らぎ。
- [ ] 波形表示、再生、シーク、変更点の移動・削除・差し替え。

- [x] **PCファースト**の横長プリセットカードと重なり回帰対策 — Issue #35（旧Private開発履歴） / PR #37（旧Private開発履歴）。現行の新「セリフ」画面（1 WAV、none/open）は Issue #36（旧Private開発履歴） / PR #38（旧Private開発履歴）で実装。Mac実PSD/WAV→Resolve Human PASSは後続PR #43で確認。
- [x] Android実機フィードバックのUI改善と**ブラウザ限定の自動復元** — Issue #31（旧Private開発履歴） / PR #32（旧Private開発履歴）。PSD fingerprint検証付き復元、プリセットの名前重複防止、PCドラッグ取っ手＋スマホ↑↓、見出し簡素化。キャラクター設定のJSONファイル保存・読み込みはPR #45で実装済み。保存はChrome/Edgeの標準保存ダイアログ（保存名・場所を選択）を使用し、非対応ブラウザでは自動ダウンロードせずエラー。Mac Chromeで保存先・名前指定、保存通知、キャンセル操作のHuman UX PASS。JSON内容・復元の一致はPlaywrightで自動検証。

### レイヤー選択UIの改善（Issue #53、作業中）

- [x] **Open役割をワンクリックの「なし／閉／開」ボタン化** — PR #57（旧Private開発履歴） でmain統合済み。Web UI・Python CI、独立ブロッキング監査、Mac実PSDでの操作性Human評価PASS（2026-11-05）。基本ON/OFF・特殊割当を保持。
- [x] **レイヤー名の選択とプレビューの範囲強調** — PR #58（旧Private開発履歴） で実装。チェックによる基本表示とレイヤー名による選択を分離し、index-pathとPSD上のbboxで即時フィードバック。Web UI・Python CI、独立ブロッキングレビュー、Mac実PSD Human UXをそれぞれPASS（2026-11-05〜06）。
- [ ] さらに必要な行選択操作・排他グループ等はHuman UX結果に基づき判断。PSDレイヤー名から関係を推測する機能は無断導入しない。

## Phase 3 — workflow integration：複数WAVの項目別編集から着手

- [x] **複数WAVの登録・選択・並べ替え・一覧削除と項目別の個別書き出し** — Public Issue #4。安定IDで元パス（同一ファイルの複数登録・同名別パス・Unicode NFDを含む）、解析結果、プリセット、口パク方式、fps、保存設定を独立管理。選択した1項目に既存のPCM入りMOV＋個別OTIO書き出しを適用。セリフ画面とプリセット画面の往復中は一覧を保持するが、正式な制作プロジェクト保存／再読み込み復元は未実装。実装ブランチ `feat/4-multi-wav` の変更であり、mainでの利用はPRマージ後。
- [ ] 1 WAVから複数キャラクターMOV、聞き手のリアクション。
- [ ] 汎用ループ待機モーションと場面専用待機。
- [x] **複数WAVのFinder一括選択、ドラッグ並べ替え、個別／一覧順連続再生、1キャラ全件MOV＋個別OTIO書き出し** — Public Issue #14 / Draft PR #15（PR #13をbaseとするstacked変更）。既存の単一キャラPCM入りMOV＋個別OTIO生成を逐次再利用し、衝突事前検証・既存ペア上書きの明示確認・部分失敗結果・元素材不変を維持。Mac Humanフィードバック（11/7）：再生ボタンをWAV各行へ、ドラッグ取っ手を左端へ移動し、単体・全件を同じ書き出しパネルへ統合。各WAVの口パク初期値「なし」を明示し、プリセット・方式の全件適用は確認付き操作とする。個別／全件のレンダリングAPI要求構築は共有し、同一入力設定の出力を回帰テストで照合。2026-11-09のMac Human UXは一覧操作・試聴・統合書き出し・口パク一致までPASS。追加フィードバックにより、WAV行のプリセット・口パク方式をそれぞれ直接選べるプルダウンへ変更し、表記は「なし／open」に統一、デスクトップ横幅も拡張（2026-11-10 Mac Human全件PASS）。続いて不要な「選択中のWAV」セクションを撤去し、全件適用操作をWAV一覧へ、口パク・瞬きの警告を書き出しパネルへ移動。書き出しパネルを全幅配置に変更（この最終整理分のMac Human画面確認は未実施）。CI・独立レビュー・Mac Human UXは別ゲート。mainへの統合は両PRマージ後。
- [ ] **変更した項目だけ再生成**する管理、安定したメディア参照パス、全体OTIOを含む完全な制作プロジェクト一括出力。
- [ ] 全体OTIOと複数発話・複数キャラの個別OTIO、単一音声所有MOVの割当、トラックとギャップの検証。**WAVコピー／同梱機能は設けない**。

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
- [ ] aiueo・目パチの役割列は後続実装。Open動作パラメータもセリフ項目側の別設計とし、現在のOpen役割ボタンでは設定しない。


- [x] 縦長PSDの全体表示と最大8倍拡大・ドラッグ移動・口元フォーカスをPR #41で修正。Mac実PSDで全体・口元・口形切替のHuman PASS（2026-11-01）。


## Issue #42 — 同名MOV/OTIOの上書き／別名書き出し（PR #43）

- [x] 新「セリフ」画面でMOV・OTIO両方あり→上書き（既定）／別名、未使用名の提案と保存結果パスの表示。
- [x] 片割れ・symlink・復旧領域残存の同名書き出しを禁止。生成・検証後の排他的公開と通常失敗時の復旧を実装。二ファイルの完全原子性は保証しない。
- [x] 合成素材のAPI・競合・rollback・Playwrightのテストを実装し、最終exact HEADの独立コード監査PASS。Mac実PSD・WAVによる新規／上書き／別名とDaVinci Resolve透過・口パク・音声同期のHuman PASSを別途確認。最終HEADのGitHub Actionsは利用枠不足で未実施。
- [x] 旧試験版API・CLIの上書き拒否とPSD/WAV原本保護を維持。
