/* GOBOG Presale UI (hardened) — ethers v6 + WalletConnect v2 (UMD/ESM friendly)
   Drop-in replacement for presale.js

   Goals:
   - Robust against missing DOM elements / missing config fields
   - Robust against WalletConnect global name differences
   - Clearer errors + fewer silent failures
   - Prevent double-click / double-tx
*/

(async function () {
  "use strict";

  // ---------- tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs = 8000, intervalMs = 50) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = fn();
        if (v) return v;
      } catch (_) {}
      await sleep(intervalMs);
    }
    return null;
  }

  function safeText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function safeHref(id, href) {
    const el = $(id);
    if (el) el.href = href;
  }

  function nowSec() { return Math.floor(Date.now() / 1000); }

  // Console logger (UI)
  const logEl = $("log");
  const log = (s) => {
    const msg = String(s ?? "");
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    if (logEl) logEl.textContent = `[${ts}] ${msg}\n` + logEl.textContent;
    // also print to devtools
    try { console.log("[GOBOG]", msg); } catch (_) {}
  };

  // Catch silent promise errors (biar gak jadi "hantu")
  window.addEventListener("unhandledrejection", (e) => {
    const r = e?.reason;
    const msg = r?.shortMessage || r?.message || String(r || e);
    log("Unhandled: " + msg);
  });
  window.addEventListener("error", (e) => {
    const msg = e?.message || String(e);
    log("Error: " + msg);
  });

  // ---------- dependency sanity ----------
  const ethersObj = await waitFor(() => window.ethers, 12000);
  if (!ethersObj) {
    alert("Fatal: ethers belum ke-load. Cek koneksi / CDN ethers.");
    return;
  }
  const ethers = ethersObj;

  // loadGobogConfig must exist (from app-config.js)
  const loadCfgFn = await waitFor(() => window.loadGobogConfig, 12000);
  if (!loadCfgFn) {
    alert("Fatal: loadGobogConfig() belum ada. Pastikan app-config.js ke-load sebelum presale.js.");
    return;
  }

  // ---------- formatting ----------
  function formatDDHHMMSS(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const dd = Math.floor(s / 86400);
    const hh = Math.floor((s % 86400) / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(dd)}:${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }

  function fmtUnits(x, d) {
    try { return ethers.formatUnits(x, d); } catch (_) { return "-"; }
  }

  // Input sanitizer: supports "10", "10.5", "10,5" (ID), and removes thousands commas.
  function sanitizeAmountStr(s) {
    s = String(s || "").trim().replace(/\s+/g, "");
    if (!s) return "";
    // If looks like decimal-comma (e.g., 10,5) and no dot, convert to dot
    if (s.includes(",") && !s.includes(".") && /^\d+,\d+$/.test(s)) {
      s = s.replace(",", ".");
      return s;
    }
    // Otherwise remove commas as thousands separators (e.g., 1,000.25)
    s = s.replace(/,/g, "");
    return s;
  }

  function parseUnitsSafe(amountStr, decimals) {
    const s = sanitizeAmountStr(amountStr);
    if (!s) throw new Error("Empty amount");
    return ethers.parseUnits(s, decimals);
  }

  function nfmt(num, digits = 2) {
    const x = Number(num);
    if (!isFinite(x)) return "-";
    return x.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  // ---------- load + normalize config ----------
  let cfg;
  try {
    cfg = await loadCfgFn();
  } catch (e) {
    const msg = e?.message || String(e);
    log("Config error: " + msg);
    alert("Failed to load config.json. Make sure it exists & valid JSON.\n\n" + msg);
    return;
  }

  // Safe defaults (kalau config kelupaan)
  cfg = cfg || {};
  cfg.CHAIN_ID = Number(cfg.CHAIN_ID || 56);
  cfg.CHAIN_NAME = cfg.CHAIN_NAME || "BNB Smart Chain";
  cfg.RPC_URL = cfg.RPC_URL || "https://bsc-dataseed.binance.org/";
  cfg.EXPLORER_BASE = (cfg.EXPLORER_BASE || "https://bscscan.com").replace(/\/$/, "");
  cfg.SITE_URL = cfg.SITE_URL || window.location.origin;

  cfg.USDT_DECIMALS = Number(cfg.USDT_DECIMALS ?? 18);
  cfg.TOKEN_DECIMALS = Number(cfg.TOKEN_DECIMALS ?? 18);

  cfg.BASE_RATE_GOBG_PER_USDT = Number(cfg.BASE_RATE_GOBG_PER_USDT || 15);
  cfg.USE_PHASE_RATE_FOR_ESTIMATE = Boolean(cfg.USE_PHASE_RATE_FOR_ESTIMATE);

  const REQUIRED = ["USDT_ADDRESS", "PRESALE_ADDRESS"];
  const missing = REQUIRED.filter((k) => !cfg[k]);
  if (missing.length) {
    const msg = `Config missing: ${missing.join(", ")}.`;
    log(msg);
    alert(msg + "\n\nBuka config.json dan isi address yang benar.");
    return;
  }

  const PRESALE_CAP = Number(cfg.PRESALE_TOKEN_CAP || 500000);

  // Explorer link
  safeHref("explorerPresale", cfg.PRESALE_EXPLORER_URL || `${cfg.EXPLORER_BASE}/address/${cfg.PRESALE_ADDRESS}`);

  // ---------- ABI ----------
  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)"
  ];

  const presaleAbi = [
    "function buy(uint256 usdtAmount) external",
    "function claim() external",
    "function finalize() external",
    "function claimable(address user) view returns (uint256)",
    "function endTime() view returns (uint256)",
    "function canFinalizeNow() view returns (bool)"
  ];

  // Optional stats ABI (kalau kontrak kamu punya)
  const presaleStatsAbi = [
    "function totalSold() view returns (uint256)",
    "function tokensSold() view returns (uint256)",
    "function sold() view returns (uint256)"
  ];

  // ---------- Phase UI ----------
  function buildTimeline() {
    const phases = Array.isArray(cfg.PHASES) ? cfg.PHASES : [];
    const start = Number(cfg.PRESALE_START_TIME || 0);
    if (!start || phases.length === 0) return { start, timeline: [] };

    let t = start;
    const timeline = phases.map((p) => {
      const durDays = Number(p?.duration_days || 7);
      const durSec = Math.max(1, Math.floor(durDays * 86400));
      const seg = {
        name: p?.name || "Phase",
        gobg_per_1_usdt: p?.gobg_per_1_usdt ?? "X.XXXX",
        usdt_per_gobg: p?.usdt_per_gobg ?? "X.XXXX",
        durDays,
        start: t,
        end: t + durSec
      };
      t += durSec;
      return seg;
    });

    return { start, timeline };
  }

  function getActivePhase(now) {
    const { start, timeline } = buildTimeline();
    if (!start || timeline.length === 0) return { idx: -1, phase: null, phaseEnd: start || 0, timeline };

    const totalEnd = timeline[timeline.length - 1].end;
    if (now < start) return { idx: -1, phase: null, phaseEnd: start, timeline };

    const idx = timeline.findIndex((seg) => now >= seg.start && now < seg.end);
    if (idx === -1 && now >= totalEnd) return { idx: timeline.length, phase: null, phaseEnd: totalEnd, timeline };

    return { idx, phase: timeline[idx], phaseEnd: timeline[idx].end, timeline };
  }

  function renderPhases() {
    const listEl = $("phaseList");
    const activeEl = $("phaseActive");
    const cdEl = $("phaseCountdown");
    if (!listEl || !activeEl || !cdEl) return;

    const now = nowSec();
    const info = getActivePhase(now);

    if (!cfg.PRESALE_START_TIME || !info.timeline.length) {
      activeEl.textContent = "Not configured";
      cdEl.textContent = "--:--:--:--";
      listEl.innerHTML = "";
      return;
    }

    if (info.idx < 0) {
      activeEl.textContent = "Not started";
      cdEl.textContent = formatDDHHMMSS(info.phaseEnd - now);
    } else if (info.idx >= info.timeline.length) {
      activeEl.textContent = "Ended (waiting for finalize)";
      cdEl.textContent = formatDDHHMMSS(info.phaseEnd - now);
    } else {
      const p = info.phase;
      activeEl.textContent = `${p.name} • 1 USDT = ${p.gobg_per_1_usdt} GOBG`;
      cdEl.textContent = formatDDHHMMSS(info.phaseEnd - now);
    }

    listEl.innerHTML = info.timeline.map((p, i) => {
      let cls = "future";
      if (info.idx >= info.timeline.length) cls = "past";
      else if (i < info.idx) cls = "past";
      else if (i === info.idx) cls = "current";
      if (info.idx < 0) cls = "future";

      const isFuture = cls === "future";
      const shownTokensPerUsdt = isFuture ? "X.XXXX" : p.gobg_per_1_usdt;
      const shownUsdtPerGobg = isFuture ? "X.XXXX" : p.usdt_per_gobg;

      return `
        <div class="phase ${cls}">
          <div class="left">
            <div class="name">${p.name}</div>
            <div class="meta">${p.durDays} days • 1 USDT = ${shownTokensPerUsdt} GOBG</div>
          </div>
          <div class="price">${shownUsdtPerGobg} USDT / GOBG</div>
        </div>
      `;
    }).join("");
  }

  renderPhases();
  setInterval(renderPhases, 1000);

  function getUiTokensPerUsdt() {
    const info = getActivePhase(nowSec());
    if (info.idx >= 0 && info.idx < info.timeline.length) {
      const v = Number(info.phase?.gobg_per_1_usdt);
      if (isFinite(v) && v > 0) return v;
    }
    return cfg.BASE_RATE_GOBG_PER_USDT || 15;
  }

  // ---------- Wallet/Contracts state ----------
  let eip1193 = null;
  let provider = null;
  let signer = null;
  let userAddr = null;
  let usdt = null;
  let presale = null;
  let wcProvider = null;

  // UI enable/disable
  const btnApprove = $("approveBtn");
  const btnBuy = $("buyBtn");
  const btnClaim = $("claimBtn");
  const btnFinalize = $("finalizeBtn");
  const btnConnect = $("connectBtn");

  function setTxButtonsEnabled(on) {
    if (btnApprove) btnApprove.disabled = !on;
    if (btnBuy) btnBuy.disabled = !on;
    if (btnClaim) btnClaim.disabled = !on;
    if (btnFinalize) btnFinalize.disabled = !on;
  }
  setTxButtonsEnabled(false);

  // Prevent double-click / parallel tx
  let busy = false;
  async function runLocked(label, fn) {
    if (busy) {
      log(`Busy: ${label} skipped`);
      return;
    }
    busy = true;
    try {
      if (btnConnect) btnConnect.disabled = true;
      await fn();
    } finally {
      busy = false;
      if (btnConnect) btnConnect.disabled = false;
    }
  }

  // WalletConnect global getter (UMD/ESM differences)
  function getWCGlobal() {
    // after presale.html normalization script:
    // window.WalletConnectEthereumProvider should exist if WC loaded
    return window.WalletConnectEthereumProvider || window.EthereumProvider || window.WalletConnectEthereumProvider?.default;
  }

  // Ensure injected wallet is on right chain (best effort)
  async function ensureInjectedChain() {
    const eth = window.ethereum;
    if (!eth?.request) return;

    const targetId = Number(cfg.CHAIN_ID);
    const targetHex = "0x" + targetId.toString(16);

    try {
      const current = await eth.request({ method: "eth_chainId" });
      if (String(current).toLowerCase() === targetHex.toLowerCase()) return;
    } catch (_) {}

    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: targetHex }] });
    } catch (e) {
      if (e && e.code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: targetHex,
            chainName: cfg.CHAIN_NAME || "BNB Smart Chain",
            rpcUrls: [cfg.RPC_URL],
            nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
            blockExplorerUrls: [cfg.EXPLORER_BASE],
          }],
        });
      } else {
        throw e;
      }
    }
  }

  function attachEip1193Listeners(p) {
    if (!p?.on) return;

    try {
      p.on("accountsChanged", (accs) => {
        log("accountsChanged: " + JSON.stringify(accs || []));
        // force refresh view
        if (Array.isArray(accs) && accs[0]) {
          userAddr = accs[0];
          safeText("wallet", userAddr);
          refresh().catch(() => {});
        }
      });

      p.on("chainChanged", (chainId) => {
        log("chainChanged: " + String(chainId));
        // update network text on next refresh
        refreshNetworkLabel("chainChanged").catch(() => {});
      });

      p.on("disconnect", (info) => {
        log("disconnect: " + JSON.stringify(info || {}));
        setTxButtonsEnabled(false);
        safeText("wallet", "-");
        safeText("netName", "-");
      });
    } catch (_) {}
  }

  async function refreshNetworkLabel(via) {
    if (!provider) return;
    try {
      const net = await provider.getNetwork();
      safeText("netName", `${cfg.CHAIN_NAME} (cfg ${cfg.CHAIN_ID}) • yours: ${Number(net.chainId)} • via: ${via || "-"}`);
    } catch (_) {}
  }

  async function connectWithEIP1193(p, label) {
    eip1193 = p;
    attachEip1193Listeners(eip1193);

    provider = new ethers.BrowserProvider(eip1193);

    try { await provider.send("eth_requestAccounts", []); } catch (_) {}

    signer = await provider.getSigner();
    userAddr = await signer.getAddress();
    safeText("wallet", userAddr);

    const net = await provider.getNetwork();
    safeText("netName", `${cfg.CHAIN_NAME} (cfg ${cfg.CHAIN_ID}) • yours: ${Number(net.chainId)} • via: ${label}`);

    if (Number(net.chainId) !== Number(cfg.CHAIN_ID)) {
      log(`Wrong network: connected ${Number(net.chainId)} but need ${Number(cfg.CHAIN_ID)}.`);
      alert(`Wrong network.\n\nConnected: ${Number(net.chainId)}\nRequired: ${Number(cfg.CHAIN_ID)} (${cfg.CHAIN_NAME})`);
      // still allow reading UI, but tx buttons off
      setTxButtonsEnabled(false);
    } else {
      setTxButtonsEnabled(true);
    }

    usdt = new ethers.Contract(cfg.USDT_ADDRESS, erc20Abi, signer);
    presale = new ethers.Contract(cfg.PRESALE_ADDRESS, presaleAbi, signer);

    log("Connected: " + userAddr);
    await refresh();
    await refreshGlobalStats();
  }

  async function connectInjectedOnly() {
    if (!window.ethereum) throw new Error("Injected wallet tidak ditemukan. Coba DApp Browser (Trust/MetaMask) atau extension di desktop.");
    await ensureInjectedChain();
    await connectWithEIP1193(window.ethereum, "Injected");
  }

  async function ensureWalletConnectProvider() {
    // If CDN blocked, presale.html sets __WC_LOAD_ERROR__
    if (window.__WC_LOAD_ERROR__) {
      throw new Error("WalletConnect script gagal load (CDN keblok / offline). Coba ganti koneksi, atau host file WC sendiri.");
    }

    // Wait a bit for WC global in case of slow CDN
    const WC = await waitFor(() => getWCGlobal(), 12000);
    if (!WC || typeof WC.init !== "function") {
      throw new Error("WalletConnect belum ke-load. Pastikan presale.html load WC UMD sebelum presale.js.");
    }
    if (!cfg.WALLETCONNECT_PROJECT_ID) throw new Error("Missing WALLETCONNECT_PROJECT_ID in config.json");
    if (!cfg.RPC_URL) throw new Error("Missing RPC_URL in config.json");

    if (!wcProvider) {
      wcProvider = await WC.init({
        projectId: cfg.WALLETCONNECT_PROJECT_ID,
        chains: [Number(cfg.CHAIN_ID)],
        rpcMap: { [Number(cfg.CHAIN_ID)]: cfg.RPC_URL },
        showQrModal: true,
        metadata: {
          name: `${cfg.PROJECT_NAME || "GOBOG"} Presale`,
          description: "GOBOG presale dApp",
          url: cfg.SITE_URL || window.location.origin,
          icons: [cfg.SITE_ICON || ""].filter(Boolean)
        }
      });

      // Note: 'display_uri' event exists in some builds
      try {
        wcProvider.on?.("display_uri", (uri) => log("WalletConnect URI displayed (QR modal)."));
        wcProvider.on?.("disconnect", () => log("WalletConnect disconnected"));
      } catch (_) {}
    }

    return wcProvider;
  }

  async function connectWalletConnectQR() {
    const p = await ensureWalletConnectProvider();
    // WalletConnect provider usually needs connect() before request
    if (typeof p.connect === "function") await p.connect();
    await connectWithEIP1193(p, "WalletConnect");
  }

  // ---------- Read-only stats via RPC ----------
  let rpc = null;
  let usdtRead = null;
  let tokenRead = null;
  let presaleRead = null;

  try {
    rpc = new ethers.JsonRpcProvider(cfg.RPC_URL);
    usdtRead = new ethers.Contract(cfg.USDT_ADDRESS, erc20Abi, rpc);
    if (cfg.TOKEN_ADDRESS) tokenRead = new ethers.Contract(cfg.TOKEN_ADDRESS, erc20Abi, rpc);
    presaleRead = new ethers.Contract(cfg.PRESALE_ADDRESS, [...presaleAbi, ...presaleStatsAbi], rpc);
  } catch (e) {
    log("RPC init error: " + (e?.message || String(e)));
  }

  async function trySoldFromContract() {
    if (!presaleRead) return null;
    const fns = ["totalSold", "tokensSold", "sold"];
    for (const fn of fns) {
      try {
        const v = await presaleRead[fn]();
        return { method: `presale.${fn}()`, raw: v };
      } catch (_) {}
    }
    return null;
  }

  async function refreshGlobalStats() {
    try {
      if (!usdtRead) return;

      const raisedRaw = await usdtRead.balanceOf(cfg.PRESALE_ADDRESS);
      const raised = parseFloat(ethers.formatUnits(raisedRaw, cfg.USDT_DECIMALS));

      let sold = null;
      let soldHow = "";

      const soldFromView = await trySoldFromContract();
      if (soldFromView) {
        sold = parseFloat(ethers.formatUnits(soldFromView.raw, cfg.TOKEN_DECIMALS));
        soldHow = soldFromView.method;
      }

      if (sold === null && tokenRead && PRESALE_CAP > 0) {
        const remainRaw = await tokenRead.balanceOf(cfg.PRESALE_ADDRESS);
        const remain = parseFloat(ethers.formatUnits(remainRaw, cfg.TOKEN_DECIMALS));
        sold = Math.max(0, PRESALE_CAP - remain);
        soldHow = "cap - token.balanceOf(presale)";
      }

      if (sold === null && Number(cfg.BASE_RATE_GOBG_PER_USDT || 0) > 0) {
        const rate = Number(cfg.BASE_RATE_GOBG_PER_USDT);
        sold = raised * rate;
        soldHow = `raised * ${rate}`;
      }

      const buySoldText = $("buySoldText");
      const buySoldBar = $("buySoldBar");
      const buyRaisedText = $("buyRaisedText");

      if (buyRaisedText) buyRaisedText.textContent = `Raised: ${nfmt(raised, 2)} USDT`;

      if (sold === null) {
        if (buySoldText) buySoldText.textContent = `- / ${PRESALE_CAP.toLocaleString()}`;
        if (buySoldBar) buySoldBar.style.width = "0%";
      } else {
        const pct = PRESALE_CAP > 0 ? Math.min(100, (sold / PRESALE_CAP) * 100) : 0;
        if (buySoldText) buySoldText.textContent = `${nfmt(sold, 2)} / ${PRESALE_CAP.toLocaleString()} (${pct.toFixed(2)}%)`;
        if (buySoldBar) buySoldBar.style.width = pct.toFixed(2) + "%";
      }

      // Optional debug in console area
      // log(`Stats: raised=${nfmt(raised,2)} sold=${sold===null?"-":nfmt(sold,2)} (${soldHow})`);
    } catch (e) {
      log("Global stats error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function refresh() {
    if (!signer || !userAddr || !usdt || !presale) return;
    try {
      const [bal, cl, end] = await Promise.all([
        usdt.balanceOf(userAddr),
        presale.claimable(userAddr),
        presale.endTime()
      ]);

      safeText("usdtBal", fmtUnits(bal, cfg.USDT_DECIMALS));
      safeText("claimable", fmtUnits(cl, cfg.TOKEN_DECIMALS));
      safeText("ends", new Date(Number(end) * 1000).toLocaleString());
    } catch (e) {
      log("Refresh error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  // ---------- tx actions ----------
  function requireConnected() {
    if (!signer || !userAddr || !usdt || !presale) {
      alert("Wallet belum connect.");
      return false;
    }
    return true;
  }

  async function approveUSDT() {
    if (!requireConnected()) return;

    const amtStrRaw = $("amt")?.value || "";
    const amtStr = sanitizeAmountStr(amtStrRaw);
    if (!amtStr) return alert("Enter USDT amount first.");

    let amt;
    try { amt = parseUnitsSafe(amtStr, cfg.USDT_DECIMALS); }
    catch (_) { return alert("Invalid amount."); }

    await runLocked("approve", async () => {
      try {
        const allowance = await usdt.allowance(userAddr, cfg.PRESALE_ADDRESS);
        if (allowance >= amt) {
          log("Allowance already sufficient.");
          return;
        }
        const tx = await usdt.approve(cfg.PRESALE_ADDRESS, amt);
        log("Approve tx: " + tx.hash);
        await tx.wait();
        log("Approve confirmed.");
        await refresh();
        await refreshGlobalStats();
      } catch (e) {
        log("Approve error: " + (e?.shortMessage || e?.message || String(e)));
      }
    });
  }

  async function buy() {
    if (!requireConnected()) return;

    const amtStrRaw = $("amt")?.value || "";
    const amtStr = sanitizeAmountStr(amtStrRaw);
    if (!amtStr) return alert("Enter USDT amount first.");

    let amt;
    try { amt = parseUnitsSafe(amtStr, cfg.USDT_DECIMALS); }
    catch (_) { return alert("Invalid amount."); }

    await runLocked("buy", async () => {
      try {
        const allowance = await usdt.allowance(userAddr, cfg.PRESALE_ADDRESS);
        if (allowance < amt) {
          log("Allowance too low. Click Approve first.");
          return;
        }
        const tx = await presale.buy(amt);
        log("Buy tx: " + tx.hash);
        await tx.wait();
        log("Buy confirmed.");
        await refresh();
        await refreshGlobalStats();
      } catch (e) {
        log("Buy error: " + (e?.shortMessage || e?.message || String(e)));
      }
    });
  }

  async function claim() {
    if (!requireConnected()) return;

    await runLocked("claim", async () => {
      try {
        const tx = await presale.claim();
        log("Claim tx: " + tx.hash);
        await tx.wait();
        log("Claim confirmed.");
        await refresh();
        await refreshGlobalStats();
      } catch (e) {
        log("Claim error: " + (e?.shortMessage || e?.message || String(e)));
      }
    });
  }

  async function finalize() {
    if (!requireConnected()) return;

    await runLocked("finalize", async () => {
      try {
        const ok = await presale.canFinalizeNow();
        if (!ok) {
          log("Cannot finalize yet (time not ended / not sold out).");
          return;
        }
        const tx = await presale.finalize();
        log("Finalize tx: " + tx.hash);
        await tx.wait();
        log("Finalize confirmed.");
        await refresh();
        await refreshGlobalStats();
      } catch (e) {
        log("Finalize error: " + (e?.shortMessage || e?.message || String(e)));
      }
    });
  }

  function updateEstimate() {
    const estEl = $("estOut");
    const inEl = $("amt");
    if (!estEl || !inEl) return;

    const amtStr = sanitizeAmountStr(inEl.value || "");
    if (!amtStr) { estEl.textContent = "Estimated output: -"; return; }

    const x = Number(amtStr);
    if (!isFinite(x) || x <= 0) { estEl.textContent = "Estimated output: -"; return; }

    const rate = cfg.USE_PHASE_RATE_FOR_ESTIMATE ? getUiTokensPerUsdt() : (cfg.BASE_RATE_GOBG_PER_USDT || 15);
    const out = x * rate;
    const tag = cfg.USE_PHASE_RATE_FOR_ESTIMATE ? "UI phase rate" : "Base rate";
    estEl.textContent = `Estimated output (${tag}): ${out.toLocaleString()} GOBG`;
  }

  // ---------- Connect Modal ----------
  const backdrop = $("cmBackdrop");
  const btnInjected = $("cmInjected");
  const btnWC = $("cmWC");
  const btnCancel = $("cmCancel");

  function openConnectModal() {
    if (!backdrop) return;
    if (btnInjected) btnInjected.disabled = !window.ethereum;
    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function closeConnectModal() {
    if (!backdrop) return;
    backdrop.classList.remove("show");
    backdrop.setAttribute("aria-hidden", "true");
  }

  backdrop?.addEventListener("click", (e) => {
    if (e.target === backdrop) closeConnectModal();
  });
  btnCancel?.addEventListener("click", closeConnectModal);

  btnInjected?.addEventListener("click", async () => {
    closeConnectModal();
    try { await connectInjectedOnly(); }
    catch (err) {
      const msg = err?.message || String(err);
      log("Connect error: " + msg);
      alert("Connect failed: " + msg);
    }
  });

  btnWC?.addEventListener("click", async () => {
    closeConnectModal();
    try { await connectWalletConnectQR(); }
    catch (err) {
      const msg = err?.message || String(err);
      log("Connect error: " + msg);
      alert("Connect failed: " + msg);
    }
  });

  // ---------- bind UI ----------
  btnConnect?.addEventListener("click", (e) => {
    e.preventDefault();
    openConnectModal();
  });

  btnApprove?.addEventListener("click", approveUSDT);
  btnBuy?.addEventListener("click", buy);
  btnClaim?.addEventListener("click", claim);
  btnFinalize?.addEventListener("click", finalize);
  $("amt")?.addEventListener("input", updateEstimate);

  // refresh loops
  setInterval(() => { if (signer) refresh().catch(() => {}); }, 10000);
  setInterval(() => { refreshGlobalStats().catch(() => {}); }, 10000);

  // initial
  updateEstimate();
  refreshGlobalStats().catch(() => {});
  log("UI ready (hardened).");
})();
