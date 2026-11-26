# 公開条件に向けた改善案

2026-11-26 JST。提案のみ。新しい速度実験・本番変更・公開は未実施。

## 入力

GitHub Issue9/8を本文と全コメント込みでgh issue viewから保存（issue-9.json/md、issue-8.json/md）。Issueは報告者の観測であり今回の独立再現ではない。特にIssue9は公開版内蔵rustcとリポジトリのrustcが同一バイトではないと明記。10倍を目標保証に使わない。

既存のbatching-on4訪問のJSONLからcandidate-phases.jsonを抽出。全体36.10–38.31秒、project開始前13.49–15.46秒、project activation7.07–8.06秒、semantic warming13.95–15.48秒。各行を個別に評価し異なる中央値を加算しない。ネットワーク非制限のローカルpreviewなので公開CDN cold30秒の達成証拠ではない。補完/診断の実操作は既存ready後に別測定であり、合格ゲートは要求どおり実操作完了まで一つの時計で測る必要がある。

## 推奨順

0. 受け入れ計測: ページ遷移から現在文書の補完/診断両方の正しい結果まで。cold/reload別。Cargo公開版比較は同一プロジェクト・同一flags・同一端末で初回build/無変更再build/変更後build/runを分け、実結果と終了を確認。許容低下率は勝手に設定しない。
1. 既存batched/waiter-aware/強最適化を候補基準として固定。これらを追加の未実施最適化として二重計上しない。30秒は未達。旧sysroot-only Cargo bypassを最優先に戻さない（保存startupにはcargoCallsBeforeProjectActivation=0）。
2. project activationとsemantic warmingの再計算調査。didChangeConfiguration→crate graph→didClose/didOpenの実際の順序を読むと、再構成/再解析の重複が候補。stdlib cacheはすでにloaded+mergedなので「キャッシュ追加」ではなく、復元済みデータの無効化/再計算を測る。初期設定統合や文書再open削減は正しさを維持できる場合のみ。version付きdiagnostics/inlayHint要求応答・cache-hitを記録し確認。readiness削除や診断無効化で見かけだけ短縮しない。
3. analyzer-first起動。現在一体のcoreに含まれるCargo/rustc/LLVMを編集開始の経路から外し、RA+必要VFS/stdlibだけを先行。compilerは別モジュールとして遅延/背景ロード。ただし最初のCargoで余分なロード時間が増える危険があり、クリックから終了まで測定して非劣化を確認。既存のprefetch/並列化と重複しないよう依存グラフを測る。
4. Issue9の独立memory構成を小さく比較。まずRA単体を未loweringの独立Wasm instance+shared memory（RA threads内のみ共有）で動かし、VFSは粗粒度RPC/共有バッファ。別instanceごとのsingle memoryは単一moduleのmulti-memoryとは別案であり、Safariのmulti-memory非対応だけを理由に除外しない。対象ブラウザのthreads/COOP/COEP等は別途検証。native multi-memory版+fallbackも別候補。共通memoryの移動がなくなる設計ならper-access relocation lockを不要にできる可能性があるが、現行構造でロックだけ外すのは不可。Cargo経路を初期試作で変えない。
5. stdout ring buffer/呼出まとめは後順位。Issue9のtype-check/borrow-check/LLVMのような計算主体の遅さはI/O削減だけでは説明/解消できない。I/O支配のプロファイルが出た場合に優先度を上げる。スレッド数増加もまず1/2/4のpaired測定、無制限に増やさない。

Issue8の約256MiB上限/worker終了後の無限待機は旧公開ビルドでの報告。現候補で同じ問題が残ると断定せず、Cargo試験に大きめの入力と失敗後の再実行を含める。速度が速くても無限待機やセッション破損は合格にしない。

## 見通し

30秒には既存4試行で少なくとも約6.1–8.3秒+実操作確認分の短縮が必要。余裕を持った内部目標25秒程度は提案であり新しいユーザー指定条件ではない。2で再計算を削れれば低コスト、残れば3/4が本命。削減秒数は未測定で保証しない。

Sources: https://github.com/oligamiq/rubrc/issues/9 ; https://github.com/oligamiq/rubrc/issues/8 ; ../../results/memory-lock-batching-45131532216/REPORT.md ; ../../../page/src/rust_lsp_startup.ts
