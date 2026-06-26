// Cloudflare Pages Function: POST /api/judge
// APIキーはここ（サーバ側 env）にだけ存在する。ブラウザには出さない。

export async function onRequestPost({ request, env }) {
  if (!env.APP_PASSWORD) return json({ error: "サーバ未設定: APP_PASSWORD" }, 500);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "サーバ未設定: ANTHROPIC_API_KEY" }, 500);

  const pass = request.headers.get("x-app-password") || "";
  if (pass !== env.APP_PASSWORD) return json({ error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  const url = ((body && body.url) || "").trim();
  const platform = (body && body.platform) || "unknown";
  if (!url) return json({ error: "url required" }, 400);

  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
        messages: [{ role: "user", content: buildPrompt(url, platform) }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      }),
    });
  } catch (e) {
    return json({ error: "fetch失敗: " + (e.message || String(e)) }, 502);
  }

  if (!r.ok) {
    const t = await r.text();
    return json({ error: "anthropic " + r.status, detail: t.slice(0, 400) }, 502);
  }

  const data = await r.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return json({ text });
}

// 簡易な疎通確認用
export async function onRequestGet() {
  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function buildPrompt(url, platform) {
  const label =
    platform === "TikTok" ? "TikTok"
    : platform === "Instagram" ? "Instagram"
    : "SNS（InstagramまたはTikTok。URLから判断すること）";
  return `あなたはインフルエンサーマーケティングのリサーチアシスタントです。次の${label}アカウントについて web_search ツールで公開情報を丁寧に調べ、判定してください。1回の検索で足りなければ、観点ごとに複数回検索すること。

対象URL: ${url}

【調べ方の指示】
- まずアカウント本体（表示名・bio・固定リンク）を検索。次にフォロワー数、楽天ROOM、Amazonアフィリの痕跡を、それぞれ別クエリで調べる。
- 楽天ROOMの判定が最重要。以下を必ず確認する：
  ・bioやプロフィールのリンク先（Linktree / lit.link / プロフ集約ページ）の中身
  ・「楽天ROOM」「ROOM」「room.rakuten.co.jp」「rt.rakuten」等のURL・文言
  ・"アカウント名 楽天ROOM" で検索してヒットするか
  少しでも痕跡があれば「有」、明確に無さそうなら「無」、判断材料が全く無ければ「不明」。
- フォロワー数は最新の数値をできるだけ正確に。概数の丸めすぎは避け、判明した実数に近い値を返す（例: 156000、27300）。
- Amazonは「Amazonアソシエイト」「適格販売により収入を得ています」「amzn.to」「amazon.co.jp/...tag=」等の痕跡があれば「済」、無ければ「不明」。
- ジャンルは投稿内容の主軸で判断。投稿頻度は直近の投稿日から月あたりの回数を推定。購入品紹介は商品レビュー/購入報告が主体なら「有」。

【出力手順】
まず<thinking>タグ内に、各観点で何が分かったか根拠を簡潔に書く。その後で、次のキーを持つJSONオブジェクトのみを出力する（JSONの前後に説明やコードフェンスを付けない）:
{
  "accountName": "表示名（不明なら@ハンドル）",
  "platform": "Instagram|TikTok|不明",
  "followers": "判明したフォロワー数（できるだけ実数。例: 156000 / 27300 / 不明）",
  "genre": "暮らし・日用品|節約・ポイ活|ガジェット|収納・家事|育児・ベビー|プチプラ美容|インテリア|ファッション|その他 のいずれか",
  "rakutenRoom": "有|無|不明",
  "amazon": "済|不明",
  "postFreq": "月4回以上|月1〜3回|月1回未満|不明",
  "purchaseIntro": "有|無|不明",
  "note": "根拠を一言（任意）"
}
値は必ず選択肢と完全一致させること。`;
}
