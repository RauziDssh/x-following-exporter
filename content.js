(() => {
  if (window.__xFollowingExporterLoaded) return;
  window.__xFollowingExporterLoaded = true;

  // 収集したユーザーデータを保持するMap (key: lowercase handle)
  const collectedUsers = new Map();
  let isRunning = false;
  let scrollTimer = null;
  let noNewUsersCount = 0;
  let lastUrl = location.href;

  // ノードから絵文字(img.alt)を含めてテキストを抽出するヘルパー
  function extractTextWithEmojis(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || "";
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === "IMG") {
        return node.getAttribute("alt") || "";
      }
      if (node.tagName === "SVG") {
        return "";
      }
      let result = "";
      for (const child of node.childNodes) {
        result += extractTextWithEmojis(child);
      }
      return result;
    }
    return "";
  }

  // 単一の UserCell からユーザー情報を抽出
  function parseUserCell(cell) {
    // 1. @screen_name (ユーザーID) の特定
    let handle = "";

    // セル内の @xxxx テキストを探す
    const allSpans = cell.querySelectorAll("span");
    for (const span of allSpans) {
      const txt = (span.textContent || "").trim();
      if (/^@[A-Za-z0-9_]{1,15}$/.test(txt)) {
        handle = txt.slice(1);
        break;
      }
    }

    // もしspanから見つからなければリンクのhrefから探す
    const links = Array.from(cell.querySelectorAll('a[href^="/"]'));
    if (!handle) {
      const reserved = new Set([
        "home", "explore", "notifications", "messages",
        "i", "search", "settings", "compose", "tos", "privacy"
      ]);
      for (const a of links) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
        if (m && !reserved.has(m[1].toLowerCase())) {
          handle = m[1];
          break;
        }
      }
    }

    if (!handle) return null;

    // 2. 表示名 (名前) の特定
    let displayName = "";
    const targetPath = `/${handle.toLowerCase()}`;

    for (const a of links) {
      const href = (a.getAttribute("href") || "").toLowerCase();
      if (href !== targetPath) continue;

      // アバター画像リンクは除外
      if (a.querySelector('[data-testid^="UserAvatar"]') || a.querySelector('img[src*="profile_images"]')) {
        continue;
      }

      const rawText = extractTextWithEmojis(a).trim();
      if (!rawText) continue;

      // @handle のみのリンクはスキップ
      if (rawText.toLowerCase() === `@${handle.toLowerCase()}`) {
        continue;
      }

      // もし1つのリンク内に表示名と @handle が両方含まれている場合は @handle 以降を除去
      const atIdx = rawText.indexOf(`@${handle}`);
      if (atIdx > 0) {
        displayName = rawText.slice(0, atIdx).trim();
      } else {
        displayName = rawText;
      }

      if (displayName) break;
    }

    // フォールバック: dir="ltr" から取得
    if (!displayName) {
      const dirNodes = cell.querySelectorAll('[dir="ltr"]');
      for (const node of dirNodes) {
        const txt = extractTextWithEmojis(node).trim();
        if (txt && !txt.startsWith("@")) {
          displayName = txt;
          break;
        }
      }
    }

    if (!displayName) {
      displayName = handle;
    }

    // 3. 「フォローされています」バッジの有無を判定
    let isFollowedBack = false;
    if (cell.querySelector('[data-testid="userFollowIndicator"]')) {
      isFollowedBack = true;
    } else {
      for (const span of allSpans) {
        const t = (span.textContent || "").trim();
        if (t === "フォローされています" || t === "Follows you") {
          isFollowedBack = true;
          break;
        }
      }
    }

    return {
      displayName,
      handle: `@${handle}`,
      rawHandle: handle,
      isFollowedBack
    };
  }

  // 現在画面に表示されているメインカラムのUserCellを走査して収集
  function scanVisibleUsers() {
    // 右サイドバーの「おすすめユーザー」を除外するため primaryColumn 内に限定
    const primaryColumn =
      document.querySelector('[data-testid="primaryColumn"]') ||
      document.querySelector('main[role="main"]');

    if (!primaryColumn) return 0;

    const cells = primaryColumn.querySelectorAll('[data-testid="UserCell"]');
    let newlyAdded = 0;

    for (const cell of cells) {
      // サイドバー内の要素なら除外
      if (cell.closest('[data-testid="sidebarColumn"]')) continue;

      const user = parseUserCell(cell);
      if (user) {
        const key = user.rawHandle.toLowerCase();
        if (!collectedUsers.has(key)) {
          newlyAdded++;
        }
        collectedUsers.set(key, user);
      }
    }

    updatePanelStats();
    return newlyAdded;
  }

  // 自分のフォロー中ページのURLを取得（ナビゲーションバーのプロフィールリンクから判定）
  function getMyFollowingUrl() {
    const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    if (profileLink) {
      const href = profileLink.getAttribute("href");
      if (href && /^\/[A-Za-z0-9_]+$/.test(href)) {
        return `${location.origin}${href}/following`;
      }
    }
    return null;
  }

  function isOnFollowingOrFollowersPage() {
    return /^\/[A-Za-z0-9_]+\/(following|followers|verified_followers)\b/i.test(location.pathname);
  }

  // 自動スクロール処理の開始
  function startCollection() {
    if (isRunning) return;

    if (!isOnFollowingOrFollowersPage()) {
      const myFollowingUrl = getMyFollowingUrl();
      if (myFollowingUrl) {
        if (confirm("現在フォロー一覧ページではありません。\n自分の「フォロー中」ページへ移動しますか？")) {
          location.href = myFollowingUrl;
          return;
        }
      } else {
        setStatus("対象のユーザーの「フォロー中 (/following)」ページを開いてから開始してください。", "warn");
        return;
      }
    }

    isRunning = true;
    noNewUsersCount = 0;
    updateControlButtons();
    setStatus("自動スクロール＆取得中... 画面をそのままにしてお待ちください", "running");

    // 初回スキャン
    scanVisibleUsers();

    const speedSelect = document.getElementById("xfe-speed-select");
    const intervalMs = speedSelect ? parseInt(speedSelect.value, 10) : 800;

    scrollTimer = setInterval(() => {
      if (!isRunning) return;

      const added = scanVisibleUsers();

      // ローディングスピナーが表示されているか確認
      const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
      const isLoading = primaryColumn
        ? primaryColumn.querySelector('[role="progressbar"]') !== null
        : false;

      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 150;

      if (added === 0 && atBottom && !isLoading) {
        noNewUsersCount++;
      } else if (added > 0) {
        noNewUsersCount = 0;
      }

      // ページ最下部で新規ユーザーが一定回数連続で見つからなければ完了とみなす
      if (noNewUsersCount >= 6) {
        stopCollection(true);
        return;
      }

      // スクロール実行
      window.scrollBy({
        top: Math.max(450, Math.floor(window.innerHeight * 0.65)),
        behavior: "smooth"
      });
    }, intervalMs);
  }

  // 自動スクロール処理の停止
  function stopCollection(completed = false) {
    isRunning = false;
    if (scrollTimer) {
      clearInterval(scrollTimer);
      scrollTimer = null;
    }
    scanVisibleUsers();
    updateControlButtons();

    if (completed) {
      setStatus(`取得完了！ 合計 ${collectedUsers.size} 人のユーザーを取得しました。`, "done");
    } else {
      setStatus(`一時停止中（現在 ${collectedUsers.size} 人取得済み）`, "");
    }
  }

  // 収集データのリセット
  function resetCollection() {
    if (isRunning) {
      stopCollection(false);
    }
    collectedUsers.clear();
    noNewUsersCount = 0;
    updatePanelStats();
    setStatus("データをリセットしました。「取得開始」を押すと収集を始めます。", "");
  }

  // CSVフィールドのエスケープ
  function escapeCsvField(value) {
    const str = String(value ?? "");
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  // CSV生成＆ダウンロード（Excelで文字化けしないUTF-8 BOM付き）
  function downloadCsv() {
    scanVisibleUsers();

    if (collectedUsers.size === 0) {
      alert("まだユーザーが取得されていません。「取得開始」を押してリストを読み込んでください。");
      return;
    }

    const filterSelect = document.getElementById("xfe-filter-select");
    const filterMode = filterSelect ? filterSelect.value : "all";

    let users = Array.from(collectedUsers.values());
    if (filterMode === "oneway") {
      users = users.filter((u) => !u.isFollowedBack);
    } else if (filterMode === "mutual") {
      users = users.filter((u) => u.isFollowedBack);
    }

    if (users.length === 0) {
      alert("選択された条件に一致するユーザーが0人です。");
      return;
    }

    const headers = ["表示名", "ユーザーID", "フォローされているか"];
    const rows = [headers.join(",")];

    for (const u of users) {
      const row = [
        escapeCsvField(u.displayName),
        escapeCsvField(u.handle),
        escapeCsvField(u.isFollowedBack ? "フォローされている" : "フォローされていない")
      ];
      rows.push(row.join(","));
    }

    // UTF-8 BOM (\uFEFF) を先頭に付与してExcelでの文字化けを防ぐ
    const csvContent = "\uFEFF" + rows.join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    // ファイル名に日時と対象アカウント名を含める
    const pathMatch = location.pathname.match(/^\/([A-Za-z0-9_]+)/);
    const targetAccount = pathMatch ? pathMatch[1] : "x";
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

    const a = document.createElement("a");
    a.href = url;
    a.download = `following_${targetAccount}_${timestamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus(`${users.length} 人分のCSVファイルをダウンロードしました！`, "done");
  }

  // UIパネルの統計数値を更新
  function updatePanelStats() {
    const totalEl = document.getElementById("xfe-stat-total");
    const mutualEl = document.getElementById("xfe-stat-mutual");
    const onewayEl = document.getElementById("xfe-stat-oneway");
    const badgeEl = document.getElementById("xfe-header-count");
    const dlBtn = document.getElementById("xfe-btn-download");

    if (!totalEl) return;

    let mutual = 0;
    let oneway = 0;
    for (const u of collectedUsers.values()) {
      if (u.isFollowedBack) {
        mutual++;
      } else {
        oneway++;
      }
    }

    totalEl.textContent = String(collectedUsers.size);
    mutualEl.textContent = String(mutual);
    onewayEl.textContent = String(oneway);
    if (badgeEl) badgeEl.textContent = `${collectedUsers.size}人`;
    if (dlBtn) dlBtn.disabled = collectedUsers.size === 0;
  }

  // ステータス表示の更新
  function setStatus(text, type) {
    const statusEl = document.getElementById("xfe-status");
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = "xfe-status-bar";
    if (type === "running") statusEl.classList.add("xfe-running");
    if (type === "done") statusEl.classList.add("xfe-done");
    if (type === "warn") statusEl.classList.add("xfe-warn");
  }

  // 開始・停止ボタンの表示切替
  function updateControlButtons() {
    const toggleBtn = document.getElementById("xfe-btn-toggle");
    if (!toggleBtn) return;

    if (isRunning) {
      toggleBtn.textContent = "⏸ 一時停止";
      toggleBtn.className = "xfe-btn xfe-btn-stop";
    } else {
      toggleBtn.textContent = collectedUsers.size > 0 ? "▶ 取得を再開" : "▶ 取得開始";
      toggleBtn.className = "xfe-btn xfe-btn-primary";
    }
  }

  // 画面右下のフローティングパネルを作成
  function createFloatingPanel() {
    if (document.getElementById("x-following-exporter-panel")) return;

    const panel = document.createElement("div");
    panel.id = "x-following-exporter-panel";
    if (!isOnFollowingOrFollowersPage()) {
      panel.classList.add("xfe-hidden");
    }

    panel.innerHTML = `
      <div class="xfe-header">
        <div class="xfe-title">
          <span>フォロー中CSV出力</span>
          <span id="xfe-header-count" class="xfe-badge">0人</span>
        </div>
        <div class="xfe-header-btns">
          <button id="xfe-btn-minimize" class="xfe-icon-btn" title="最小化 / 展開">_</button>
          <button id="xfe-btn-close" class="xfe-icon-btn" title="パネルを隠す">✕</button>
        </div>
      </div>
      <div class="xfe-body">
        <div id="xfe-status" class="xfe-status-bar">
          「フォロー中」ページで「▶ 取得開始」を押してください
        </div>
        <div class="xfe-stats-grid">
          <div class="xfe-stat-card">
            <div class="xfe-stat-label">取得合計</div>
            <div id="xfe-stat-total" class="xfe-stat-val">0</div>
          </div>
          <div class="xfe-stat-card">
            <div class="xfe-stat-label">相互フォロー</div>
            <div id="xfe-stat-mutual" class="xfe-stat-val xfe-mutual">0</div>
          </div>
          <div class="xfe-stat-card">
            <div class="xfe-stat-label">片思い(未返)</div>
            <div id="xfe-stat-oneway" class="xfe-stat-val xfe-oneway">0</div>
          </div>
        </div>
        <div class="xfe-options">
          <div class="xfe-option-row">
            <span>出力対象</span>
            <select id="xfe-filter-select" class="xfe-select">
              <option value="all">全員（すべて出力）</option>
              <option value="oneway">フォローされていない人のみ</option>
              <option value="mutual">相互フォローのみ</option>
            </select>
          </div>
          <div class="xfe-option-row">
            <span>スクロール速度</span>
            <select id="xfe-speed-select" class="xfe-select">
              <option value="1200">ゆっくり（安全・確実）</option>
              <option value="800" selected>標準（おすすめ）</option>
              <option value="450">高速</option>
            </select>
          </div>
        </div>
        <div class="xfe-controls-row">
          <button id="xfe-btn-toggle" class="xfe-btn xfe-btn-primary">▶ 取得開始</button>
          <button id="xfe-btn-reset" class="xfe-btn xfe-btn-outline" title="取得データをクリア">リセット</button>
        </div>
        <div class="xfe-controls-row" style="margin-bottom: 0;">
          <button id="xfe-btn-download" class="xfe-btn xfe-btn-secondary" disabled>
            ⬇ CSVダウンロード
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById("xfe-btn-toggle").addEventListener("click", () => {
      if (isRunning) {
        stopCollection(false);
      } else {
        startCollection();
      }
    });

    document.getElementById("xfe-btn-reset").addEventListener("click", () => {
      resetCollection();
    });

    document.getElementById("xfe-btn-download").addEventListener("click", () => {
      downloadCsv();
    });

    document.getElementById("xfe-btn-minimize").addEventListener("click", () => {
      panel.classList.toggle("xfe-minimized");
    });

    document.getElementById("xfe-btn-close").addEventListener("click", () => {
      if (isRunning) stopCollection(false);
      panel.classList.add("xfe-hidden");
    });
  }

  // SPAのページ遷移（URL変化）を監視して、/following に入ったらパネルを自動表示
  function observeNavigation() {
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        const panel = document.getElementById("x-following-exporter-panel");
        if (panel && isOnFollowingOrFollowersPage()) {
          panel.classList.remove("xfe-hidden");
        }
      }
    }, 700);
  }

  // 拡張機能ポップアップからのメッセージ受信
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    createFloatingPanel();
    const panel = document.getElementById("x-following-exporter-panel");

    if (msg.action === "SHOW_PANEL") {
      if (panel) {
        panel.classList.remove("xfe-hidden");
        panel.classList.remove("xfe-minimized");
      }
      sendResponse({
        ok: true,
        isFollowingPage: isOnFollowingOrFollowersPage(),
        myFollowingUrl: getMyFollowingUrl(),
        count: collectedUsers.size,
        isRunning
      });
    } else if (msg.action === "START") {
      if (panel) panel.classList.remove("xfe-hidden");
      startCollection();
      sendResponse({ ok: true });
    } else if (msg.action === "STOP") {
      stopCollection(false);
      sendResponse({ ok: true });
    } else if (msg.action === "DOWNLOAD") {
      downloadCsv();
      sendResponse({ ok: true });
    }
    return true;
  });

  // 初期化
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      createFloatingPanel();
      observeNavigation();
    });
  } else {
    createFloatingPanel();
    observeNavigation();
  }
})();
