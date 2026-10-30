document.addEventListener("DOMContentLoaded", () => {
  const showPanelBtn = document.getElementById("btn-show-panel");
  const openXBtn = document.getElementById("btn-open-x");
  const msgEl = document.getElementById("msg");

  function setMsg(text, isError = false) {
    msgEl.style.color = isError ? "#f4212e" : "#00ba7c";
    msgEl.textContent = text;
  }

  async function ensureContentScriptAndShow(tab) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { action: "SHOW_PANEL" });
      if (res && res.ok) {
        if (!res.isFollowingPage && res.myFollowingUrl) {
          await chrome.tabs.update(tab.id, { url: res.myFollowingUrl });
          window.close();
          return;
        }
        setMsg("画面右下に操作パネルを表示しました！");
      }
    } catch (_err) {
      // 拡張機能導入前から開いていたタブの場合、スクリプトを動的注入する
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["content.css"]
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"]
        });
        await chrome.tabs.sendMessage(tab.id, { action: "SHOW_PANEL" });
        setMsg("画面右下に操作パネルを表示しました！");
      } catch (e) {
        setMsg("ページを再読み込み(F5)してからもう一度お試しください。", true);
      }
    }
  }

  showPanelBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || (!tab.url.startsWith("https://x.com/") && !tab.url.startsWith("https://twitter.com/"))) {
      setMsg("先に X (x.com) のタブを開いてください。", true);
      return;
    }
    await ensureContentScriptAndShow(tab);
  });

  openXBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://x.com/" });
    window.close();
  });
});
