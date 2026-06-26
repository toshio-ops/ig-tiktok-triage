# IG / TikTok 適合判定ツール（Cloudflare Pages版）

Instagram・TikTokのアカウントURLを貼ると、Amazonアソシエイト施策の優先度を判定して
スプレッドシートに貼れる表で返すツール。**利用者はClaudeもAPIキーも不要**。
URLとパスワードを知っていればブラウザだけで使える。

APIキーはサーバ側（Cloudflareの環境変数）にだけ置き、ブラウザには出さない。
判定は `claude-sonnet-4-6` + web検索で行う（あなたのAPIキーに課金される）。

---

## 構成

```
ig-tiktok-triage/
├── functions/api/judge.js   ← Anthropic APIへのプロキシ（キーはここのenvにだけ存在）
├── src/App.jsx              ← 画面本体
├── src/main.jsx
├── index.html               ← TailwindはCDN読み込み（ビルド不要）
├── package.json
└── vite.config.js           ← ビルド出力先 dist/
```

---

## 事前準備（1回だけ）

1. **Anthropic APIキーを発行**：https://console.anthropic.com → API Keys
   （Claude.aiのサブスクとは別物。なければここで作る）
2. **web検索を有効化**：同Consoleの組織設定で Web Search を ON にする
   （これをしないと判定APIが web検索でこける）

---

## デプロイ（Cloudflare Pages・GitHub連携）

1. このフォルダをGitHubにpush
2. Cloudflare ダッシュボード → **Workers & Pages → Create → Pages → リポジトリ連携**
3. ビルド設定
   - **ビルドコマンド**：`npm run build`
   - **出力ディレクトリ**：`dist`
   - （`functions/` は自動で関数としてデプロイされる）
4. **環境変数（Production）** に2つ登録
   - `ANTHROPIC_API_KEY` … 上で発行したキー（Secret推奨）
   - `APP_PASSWORD` … チームに配る共有パスワード（任意の文字列）
5. デプロイ完了後、`https://〇〇.pages.dev` のURLとパスワードをチームに共有

> 環境変数を後から変えたら、再デプロイ（または「Retry deployment」）で反映される。

---

## ローカルで試す（任意）

```bash
npm install
cp .dev.vars.example .dev.vars   # 中身を自分のキー/パスに書き換える
npm run build
npx wrangler pages dev dist      # 関数込みでローカル起動
```

画面だけ確認したいなら `npm run dev`（ただし `/api/judge` は動かない）。

---

## 使い方

1. 画面上部にパスワードを入力（ブラウザに保存される）
2. URLを1行1件で貼る（IG・TikTok混在OK）
3. 「判定する」→ 各行が順に埋まる（同時実行数で速度調整）
4. 各セルはプルダウン/入力で手直し可
5. 「全件コピー」または「高いのみコピー」でタブ区切りをコピー → スプレッドシートに直貼り

出力列：`アカウント名 / フォロワー数 / ジャンル / 楽天room / Amazonアソシエイト / 投稿頻度(月) / 購入品紹介の有無 / 優先度 / メモ`
（プラットフォームは画面上のバッジ表示。コピーにも入れたい場合は1行追加すれば可）

---

## 注意

- **コストはあなたのキーに課金**（トークン＋web検索の従量）。URLとパスを知る人が叩くと全部あなた持ちなので、`APP_PASSWORD` の管理に注意。
- 公開情報からの推定なので精度は粗め。「不明」が多めに出る前提で、ざっと見て手で確定→コピーが速い。
- 投稿頻度・フォロワー数は検索ヒット情報からの推定で、ズレることがある。
- 簡易パスは「URLを知っただけの第三者の悪用を防ぐ」レベル。より強固にするなら Cloudflare Access を併用。

---

## よくある調整

- 優先度の境界を変える：`src/App.jsx` の `computePriority()`
- メモの定型文：同 `buildMemo()`
- 1アカウントあたりの検索回数の上限：`functions/api/judge.js` の `max_uses`
- プラットフォーム列をコピーに含める：`COLUMNS` と `toTSV()` に1項目追加
