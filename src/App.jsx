import React, { useState, useMemo, useRef, useEffect } from "react";

/* ── 選択肢（スプレッドシートのプルダウンと完全一致） ── */
const GENRES = ["暮らし・日用品", "節約・ポイ活", "ガジェット", "収納・家事", "育児・ベビー", "プチプラ美容", "インテリア", "ファッション", "その他"];
const ROOM = ["有", "無", "不明"];
const AMAZON = ["済", "不明"];
const FREQ = ["月4回以上", "月1〜3回", "月1回未満", "不明"];
const PURCHASE = ["有", "無", "不明"];
const PRIORITY = ["高い", "低い"];
// 画面表示用（編集しやすい簡易列）
const COLUMNS = ["アカウント名", "フォロワー数", "ジャンル", "楽天room", "Amazonアソシエイト", "投稿頻度(月)", "購入品紹介の有無", "優先度", "メモ"];
// コピー用＝スプレッドシートの列順に完全一致（A〜L）
const SHEET_COLUMNS = ["アカウント名", "IG URL", "IGフォロワー", "TikTok URL", "TTフォロワー", "ジャンル", "楽天room", "Amazonアソシエイト", "投稿頻度(月)", "購入品紹介の有無", "優先度", "メモ"];

/* ── ユーティリティ ── */
function parseAccount(raw) {
  const s = (raw || "").trim();
  let platform = "不明";
  let handle = s.replace(/^@/, "");
  if (/instagram\.com/i.test(s)) {
    platform = "Instagram";
    const m = s.match(/instagram\.com\/([^\/?#\s]+)/i);
    if (m) handle = m[1];
  } else if (/tiktok\.com/i.test(s)) {
    platform = "TikTok";
    const m = s.match(/tiktok\.com\/@?([^\/?#\s]+)/i);
    if (m) handle = m[1];
  }
  handle = handle.replace(/^@/, "").replace(/\/$/, "");
  return { platform, handle };
}

function snap(val, allowed, fallback) {
  if (val == null) return fallback;
  const v = String(val).trim();
  if (allowed.includes(v)) return v;
  const found = allowed.find((a) => v.includes(a) || a.includes(v));
  return found || fallback;
}

/* 「15.6万」「1.2万」「8500」「3,200」「1.5M」などを 156,000 形式の数値文字列に変換 */
function normalizeFollowers(raw) {
  if (raw == null) return "不明";
  let s = String(raw).trim();
  if (!s || /不明|なし|non|n\/a|unknown/i.test(s)) return "不明";
  // 数値＋単位を抜き出す（先頭の数値部分を採用）
  const m = s.replace(/,/g, "").match(/([0-9]+(?:\.[0-9]+)?)\s*(億|万|千|k|m|b)?/i);
  if (!m) return s; // 数値が取れなければ元のまま
  let n = parseFloat(m[1]);
  const unit = (m[2] || "").toLowerCase();
  const mult = { "億": 1e8, "万": 1e4, "千": 1e3, k: 1e3, m: 1e6, b: 1e9 };
  if (unit && mult[unit]) n *= mult[unit];
  n = Math.round(n);
  return n.toLocaleString("en-US"); // カンマ区切り
}

/* 優先度＝決定論計算：Amazon済(単独でも最優先) / room有 / 高頻度の購入品紹介 → 高い、中間は高いに倒す */
function computePriority(r) {
  if (r.amazon === "済") return "高い";
  if (r.rakutenRoom === "有") return "高い";
  if (r.purchaseIntro === "有" && r.postFreq === "月4回以上") return "高い";
  return "低い";
}

/* メモ＝採用戦略に沿った端的な定型タグのみ（モデルの所見は連結しない） */
function buildMemo(r) {
  const amazon = r.amazon === "済", room = r.rakutenRoom === "有";
  const purchase = r.purchaseIntro === "有", freq4 = r.postFreq === "月4回以上";
  if (amazon && room) return "Amazon登録者&楽天room登録者";
  if (amazon) return "Amazon登録者";
  if (room && purchase) return "楽天room登録者・購買誘導◎";
  if (room) return "楽天room登録者";
  if (purchase && freq4) return "高頻度の購入品紹介・伸びしろ";
  if (r.genre && r.genre !== "その他") return "ジャンル合致のみ";
  return "要確認";
}

/* ── API（同一オリジンの /api/judge を経由） ── */
async function judgeAccount(acct, password) {
  const res = await fetch("/api/judge", {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-password": password },
    body: JSON.stringify({ url: acct.url, platform: acct.platform }),
  });
  if (res.status === 401) throw new Error("AUTH");
  if (!res.ok) {
    let d = "";
    try { d = (await res.json()).error || ""; } catch {}
    throw new Error("サーバエラー " + res.status + (d ? "：" + d : ""));
  }
  let { text } = await res.json();
  // <thinking>…</thinking> を除去（JSONの前の根拠メモを取り除く）
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("JSON抽出失敗");
  const p = JSON.parse(text.slice(s, e + 1));

  const row = {
    accountName: (p.accountName || "@" + acct.handle).trim(),
    platform: snap(p.platform, ["Instagram", "TikTok", "不明"], acct.platform),
    followers: normalizeFollowers(p.followers),
    genre: snap(p.genre, GENRES, "その他"),
    rakutenRoom: snap(p.rakutenRoom, ROOM, "不明"),
    amazon: snap(p.amazon, AMAZON, "不明"),
    postFreq: snap(p.postFreq, FREQ, "不明"),
    purchaseIntro: snap(p.purchaseIntro, PURCHASE, "不明"),
    note: (p.note || "").trim(),
  };
  row.priority = computePriority(row);
  row.memo = buildMemo(row);
  return row;
}

async function runPool(items, worker, concurrency, onResult) {
  let idx = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (idx < items.length) {
        const cur = idx++;
        try { onResult(cur, await worker(items[cur]), null); }
        catch (err) { onResult(cur, null, err); }
      }
    })
  );
}

/* ── 小物UI ── */
const Select = ({ value, options, onChange }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="w-full bg-transparent text-[13px] text-slate-800 border border-transparent hover:border-slate-300 focus:border-indigo-500 rounded px-1 py-0.5 outline-none cursor-pointer"
  >
    {options.map((o) => <option key={o} value={o}>{o}</option>)}
  </select>
);

const PlatformBadge = ({ p }) => {
  const map = {
    Instagram: "bg-fuchsia-100 text-fuchsia-700",
    TikTok: "bg-slate-900 text-white",
    不明: "bg-slate-200 text-slate-500",
  };
  const short = p === "Instagram" ? "IG" : p === "TikTok" ? "TT" : "?";
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${map[p] || map["不明"]}`}>{short}</span>;
};

export default function App() {
  const [password, setPassword] = useState(() => {
    try { return localStorage.getItem("triage_pass") || ""; } catch { return ""; }
  });
  const [input, setInput] = useState("");
  const [concurrency, setConcurrency] = useState(3);
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState("");
  const [authError, setAuthError] = useState(false);
  const [sortHigh, setSortHigh] = useState(false);
  const taRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem("triage_pass", password); } catch {}
  }, [password]);

  const urls = useMemo(
    () => Array.from(new Set(input.split("\n").map((l) => l.trim()).filter(Boolean))),
    [input]
  );
  const done = rows.filter((r) => r.status === "done" || r.status === "error").length;
  const highCount = rows.filter((r) => r.priority === "高い" && r.status === "done").length;

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 1800); };

  async function run() {
    if (!urls.length || running || !password) return;
    setRunning(true);
    setAuthError(false);
    const accts = urls.map((u) => ({ url: u, ...parseAccount(u) }));
    setRows(accts.map((a) => ({
      url: a.url, handle: a.handle, status: "pending",
      accountName: "@" + a.handle, platform: a.platform, followers: "不明",
      genre: "その他", rakutenRoom: "不明", amazon: "不明", postFreq: "不明",
      purchaseIntro: "不明", priority: "低い", memo: "", note: "",
    })));
    await runPool(
      accts,
      (a) => judgeAccount(a, password),
      Number(concurrency),
      (i, result, err) => {
        if (err && err.message === "AUTH") setAuthError(true);
        setRows((prev) => {
          const next = [...prev];
          next[i] = err
            ? { ...next[i], status: "error", memo: err.message === "AUTH" ? "認証失敗：パスワード確認" : "取得失敗：" + err.message }
            : { ...next[i], ...result, status: "done" };
          return next;
        });
      }
    );
    setRunning(false);
  }

  function update(i, field, val) {
    setRows((prev) => {
      const next = [...prev];
      const r = { ...next[i], [field]: val };
      if (["genre", "rakutenRoom", "amazon", "postFreq", "purchaseIntro"].includes(field)) r.priority = computePriority(r);
      next[i] = r;
      return next;
    });
  }

  function toTSV(list, header) {
    const lines = [];
    if (header) lines.push(SHEET_COLUMNS.join("\t"));
    list.forEach((r) => {
      const isIG = r.platform === "Instagram";
      const isTT = r.platform === "TikTok";
      const cells = [
        r.accountName,                 // A アカウント名
        isIG ? r.url : "",             // B IG URL
        isIG ? r.followers : "",       // C IGフォロワー
        isTT ? r.url : "",             // D TikTok URL
        isTT ? r.followers : "",       // E TTフォロワー
        r.genre,                       // F ジャンル
        r.rakutenRoom,                 // G 楽天room
        r.amazon,                      // H Amazonアソシエイト
        r.postFreq,                    // I 投稿頻度(月)
        r.purchaseIntro,               // J 購入品紹介の有無
        r.priority,                    // K 優先度
        r.memo,                        // L メモ
      ];
      lines.push(cells.map((x) => String(x ?? "").replace(/[\t\n]/g, " ")).join("\t"));
    });
    return lines.join("\n");
  }

  async function copy(onlyHigh) {
    const list = rows.filter((r) => r.status === "done" && (!onlyHigh || r.priority === "高い"));
    if (!list.length) return flash("コピー対象がありません");
    const tsv = toTSV(list, false); // ヘッダー無し＝既存シートの下にそのまま貼れる
    try { await navigator.clipboard.writeText(tsv); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = tsv; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
    }
    flash(`${list.length}件をコピーしました（シートのA列にそのまま貼り付け）`);
  }

  const view = useMemo(() => {
    const arr = rows.map((r, i) => ({ ...r, _i: i }));
    if (sortHigh) arr.sort((a, b) => (a.priority === "高い" ? 0 : 1) - (b.priority === "高い" ? 0 : 1) || a._i - b._i);
    return arr;
  }, [rows, sortHigh]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900" style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div className="max-w-6xl mx-auto px-5 py-6">
        {/* header */}
        <div className="flex items-end justify-between gap-4 border-b-2 border-slate-900 pb-3 mb-4">
          <div>
            <div className="text-[11px] font-semibold tracking-[0.2em] text-indigo-600 uppercase">Amazon × toridori 採用トリアージ</div>
            <h1 className="text-2xl font-bold leading-tight">IG / TikTok 適合判定</h1>
          </div>
          <div className="text-right text-xs text-slate-500 leading-relaxed">
            <div>判定: claude-sonnet-4-6 + web検索</div>
            <div>公開情報からの推定（精度は粗め・後編集前提）</div>
          </div>
        </div>

        {/* password */}
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-white border border-slate-200 px-3 py-2">
          <span className="text-xs text-slate-500 shrink-0">アクセスパスワード</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="チーム共有のパスワード"
            className={`flex-1 text-sm outline-none border-b ${authError ? "border-rose-400" : "border-transparent focus:border-indigo-400"}`}
          />
          {authError && <span className="text-xs font-semibold text-rose-600 shrink-0">パスワードが違います</span>}
        </div>

        {/* input */}
        <div className="grid md:grid-cols-[1fr_auto] gap-3 mb-5">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={"1行に1URL（Instagram・TikTok混在OK）\nhttps://www.instagram.com/example/\nhttps://www.tiktok.com/@example"}
            rows={5}
            className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono leading-relaxed outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
          <div className="flex flex-col gap-2 md:w-44">
            <div className="text-xs text-slate-500">{urls.length} 件のURL</div>
            <label className="text-xs text-slate-600 flex items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2">
              同時実行
              <select value={concurrency} onChange={(e) => setConcurrency(e.target.value)} className="bg-transparent outline-none font-semibold">
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button
              onClick={run}
              disabled={running || !urls.length || !password}
              className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {running ? `判定中… ${done}/${rows.length}` : "判定する"}
            </button>
            <button
              onClick={() => { setRows([]); setInput(""); taRef.current?.focus(); }}
              disabled={running}
              className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
            >
              クリア
            </button>
            {!password && <div className="text-[11px] text-amber-600">パスワードを入力してください</div>}
          </div>
        </div>

        {rows.length > 0 && (
          <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${(done / rows.length) * 100}%` }} />
          </div>
        )}

        {rows.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-rose-50 px-2.5 py-1 font-semibold text-rose-700">高い {highCount}</span>
            <span className="text-slate-400">/ 完了 {rows.filter((r) => r.status === "done").length}</span>
            <div className="flex-1" />
            <button onClick={() => setSortHigh((s) => !s)} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 hover:bg-slate-100">
              {sortHigh ? "入力順に戻す" : "高い順に並べ替え"}
            </button>
            <button onClick={() => copy(false)} className="rounded-md bg-emerald-600 px-3 py-1 font-semibold text-white hover:bg-emerald-700">全件コピー</button>
            <button onClick={() => copy(true)} className="rounded-md bg-rose-600 px-3 py-1 font-semibold text-white hover:bg-rose-700">高いのみコピー</button>
          </div>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-2 font-semibold w-8"></th>
                  {COLUMNS.map((c) => <th key={c} className="px-2 py-2 font-semibold whitespace-nowrap">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {view.map((r) => {
                  const high = r.priority === "高い";
                  return (
                    <tr key={r._i} className={`border-t border-slate-100 align-middle ${high && r.status === "done" ? "bg-rose-50/40" : ""}`}>
                      <td className="px-2 py-1.5 text-center">
                        {r.status === "pending" && <span className="text-slate-300">·</span>}
                        {r.status === "running" && <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />}
                        {r.status === "done" && <span className="text-emerald-500">●</span>}
                        {r.status === "error" && <span className="text-amber-500">!</span>}
                      </td>
                      <td className="px-2 py-1.5 min-w-[150px]">
                        <div className="flex items-center gap-1.5">
                          <PlatformBadge p={r.platform} />
                          <input value={r.accountName} onChange={(e) => update(r._i, "accountName", e.target.value)}
                            className="w-full bg-transparent text-[13px] font-medium outline-none border-b border-transparent focus:border-indigo-400" />
                        </div>
                        <a href={r.url} target="_blank" rel="noreferrer" className="block truncate text-[10px] text-slate-400 hover:text-indigo-500">@{r.handle}</a>
                      </td>
                      <td className="px-2 py-1.5 w-20">
                        <input value={r.followers} onChange={(e) => update(r._i, "followers", e.target.value)}
                          onBlur={(e) => update(r._i, "followers", normalizeFollowers(e.target.value))}
                          className="w-full bg-transparent text-[12px] tabular-nums outline-none border-b border-transparent focus:border-indigo-400" />
                      </td>
                      <td className="px-2 py-1.5 min-w-[120px]"><Select value={r.genre} options={GENRES} onChange={(v) => update(r._i, "genre", v)} /></td>
                      <td className="px-2 py-1.5 w-16"><Select value={r.rakutenRoom} options={ROOM} onChange={(v) => update(r._i, "rakutenRoom", v)} /></td>
                      <td className="px-2 py-1.5 w-16"><Select value={r.amazon} options={AMAZON} onChange={(v) => update(r._i, "amazon", v)} /></td>
                      <td className="px-2 py-1.5 w-24"><Select value={r.postFreq} options={FREQ} onChange={(v) => update(r._i, "postFreq", v)} /></td>
                      <td className="px-2 py-1.5 w-16"><Select value={r.purchaseIntro} options={PURCHASE} onChange={(v) => update(r._i, "purchaseIntro", v)} /></td>
                      <td className="px-2 py-1.5 w-20">
                        <select value={r.priority} onChange={(e) => update(r._i, "priority", e.target.value)}
                          className={`w-full rounded px-1.5 py-0.5 text-[12px] font-bold outline-none cursor-pointer ${high ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-500"}`}>
                          {PRIORITY.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-1.5 min-w-[200px]">
                        <input value={r.memo} onChange={(e) => update(r._i, "memo", e.target.value)}
                          className="w-full bg-transparent text-[12px] text-slate-600 outline-none border-b border-transparent focus:border-indigo-400" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {rows.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-400">
            URLを貼って「判定する」を押すと、ここに表が表示されます。
          </div>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          優先度は自動計算（Amazon済＝単独でも最優先／楽天room有＝高い／高頻度の購入品紹介＝高い、中間は高いに倒す）。各セルは手で直せます。
          コピーはスプレッドシートの列順（A:アカウント名〜L:メモ）に完全一致・ヘッダー無し。シートのA列の空き行にそのまま貼り付けできます。フォロワーは156,000形式に整形。
        </p>
      </div>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-xs font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
