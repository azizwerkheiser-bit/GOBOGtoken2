(async function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(s) {
    const logEl = $("log");
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    const msg = String(s ?? "");
    if (logEl) logEl.textContent = `[${ts}] ${msg}\n` + logEl.textContent;
    try { console.log("[GOBOG]", msg); } catch (_) {}
  }

  window.addEventListener("unhandledrejection", (e) => {
    const r = e?.reason;
    const msg = r?.shortMessage || r?.message || String(r || e);
    log("Unhandled: " + msg);
  });
  window.addEventListener("error", (e) => {
    log("Error: " + (e?.message || String(e)));
  });

  async function waitFor(fn, timeoutMs = 12000, intervalMs = 50) {
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

  function loadScriptTag(src) {
    return new Promise((resolve, reject) => {
      // jangan dobel load
      const existed = Array.from(document.scripts).some(s => (s.src || "").includes(src));
      if (existed) return resolve(src);

      const s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.crossOrigin = "anonymous";
      s.onload = () => resolve(src);
      s.onerror = () => reject(new Error("Failed to load: " + src));
      document.head.appendChild(s);
    });
  }

  // ----- dependencies -----
  const ethers = await waitFor(() => window.ethers, 12000);
  if (!ethers) {
    alert("Fatal: ethers belum ke-load.\nCek koneksi / CDN ethers.");
    return;
  }

  const loadGobogConfig = await waitFor(() => window.loadGobogConfig, 12000);
  if (!loadGobogConfig) {
    alert(
      "Fatal: loadGobogConfig() belum ada.\n" +
      "Pastikan app-config.js ke-load sebelum presale.js.\n\n" +
      "TIP: di app-config.js tambahin: window.loadGobogConfig = loadGobogConfig;"
    );
    return;
  }

  // ----- helpers -----
  const nowSec = () => Math.floor(Date.now() / 1000);

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

  function sanitizeAmountStr(s) {
    s = String(s || "").trim().replace(/\s+/g, "");
    if (!s) return "";
    if (s.includes(",") && !s.includes(".") && /^\d+,\d+$/.test(s)) return s.replace(",", ".");
    return s.replace(/,/g, "");
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

  function safeText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function safeHref(id, href) {
    const el = $(id);
    if (el) el.href = href;
  }

  // ----- config -----
  let cfg;
  try {
    cfg = await loadGobogConfig();
  } catch (e) {
    const msg = e?.message || String(e);
    log("Config error: " + msg);
    alert("Failed to load config.json.\nMake sure it exists & valid JSON.\n\n" + msg);
    return;
  }

  cfg = cfg || {};
  cfg.CHAIN_ID = Number(cfg.CHAIN_ID || 56);
  cfg.CHAIN_NAME = cfg.CHAIN_NAME || "BNB Smart Chain";
  cfg.RPC_URL = (cfg.RPC_URL || "https://bsc-dataseed.bnbchain.org").replace(/\s+/g, "");
  cfg.EXPLORER_BASE = String(cfg.EXPLORER_BASE || "https://bscscan.com").replace(/\/$/, "");
  cfg.SITE_URL = cfg.SITE_URL || window.location.origin;

  cfg.USDT_DECIMALS = Number(cfg.USDT_DECIMALS ?? 18);
  cfg.TOKEN_DECIMALS = Number(cfg.TOKEN_DECIMALS ?? 18);

  cfg.BASE_RATE_GOBG_PER_USDT = Number(cfg.BASE_RATE_GOBG_PER_USDT || 15);
  cfg.USE_PHASE_RATE_FOR_ESTIMATE = Boolean(cfg.USE_PHASE_RATE_FOR_ESTIMATE);

  cfg.APPROVE_MAX = (cfg.APPROVE_MAX === undefined) ? true : Boolean(cfg.APPROVE_MAX);

  const required = ["USDT_ADDRESS", "PRESALE_ADDRESS"];
  const missing = required.filter((k) => !cfg[k]);
  if (missing.length) {
    const msg = "Config missing: " + missing.join(", ");
    log(msg);
    alert(msg + "\n\nBuka config.json dan isi address yang benar.");
    return;
  }

  const PRESALE_CAP = Number(cfg.PRESALE_TOKEN_CAP || 500000);

  safeHref(
    "explorerPresale",
    cfg.PRESALE_EXPLORER_URL || `${cfg.EXPLORER_BASE}/address/${cfg.PRESALE_ADDRESS}`
  );

  // ----- ABI -----
  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function decimals() view returns (uint8)"
  ];

  const presaleAbi = [
    "function buy(uint256 usdtAmount) external",
    "function claim() external",
    "function finalize() external",
    "function claimable(address user) view returns (uint256)",
    "function endTime() view returns (uint256)",
    "function canFinalizeNow() view returns (bool)"
  ];

  const presaleStatsAbi = [
    "function totalSold() view returns (uint256)",
    "function tokensSold() view returns (uint256)",
    "function sold() view returns (uint256)"
  ];

  // ----- Phase UI -----
  function buildTimeline() {
    const phases = Array.isArray(cfg.PHASES) ? cfg.PHASES : [];
    const start = Number(cfg.PRESALE_START_TIME || 0);
    if (!start || phases.length === 0) return { start, timeline: [] };

    let t = start;
    const timeline = phases.map((p) => {
      const durDays = Number(p?.duration_days || 7);
      const durSec = Math.max(1, Math.floor(durDays * 86400));
      const seg = { ...p, start: t, end: t + durSec, durDays };
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

  // ----- wallet state -----
  let provider = null;
  let signer = null;
  let userAddr = null;
  let usdt = null;
  let presale = null;
  let wcProvider = null;

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

  let busy = false;
  async function runLocked(label, fn) {
    if (busy) { log("Busy: " + label); return; }
    busy = true;
    try {
      if (btnConnect) btnConnect.disabled = true;
      await fn();
    } finally {
      busy = false;
      if (btnConnect) btnConnect.disabled = false;
    }
  }

  // Robust WC export detection (UMD beda-beda)
  function getWCClass() {
    const pkg =
      window.WalletConnectEthereumProvider ||
      window["@walletconnect/ethereum-provider"] ||
      window.EthereumProvider ||
      null;

    if (!pkg) return null;

    const cls = pkg.EthereumProvider || pkg.default || pkg;
    return (cls && typeof cls.init === "function") ? cls : null;
  }

  // Paksa WC UMD tersedia (load ulang + polyfill kalau perlu)
  async function ensureWalletConnectUMD() {
    // polyfill supaya bundle WC nggak crash kalau nyari "process"/"global"
    if (typeof window.process === "undefined") window.process = { env: {} };
    if (typeof window.global === "undefined") window.global = window;

    if (getWCClass()) return true;

    const urls = [
      "https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.13.0/dist/index.umd.min.js",
      "https://unpkg.com/@walletconnect/ethereum-provider@2.13.0/dist/index.umd.min.js"
    ];

    for (const u of urls) {
      try {
        await loadScriptTag(u);
        // kasih waktu event loop buat set global
        await sleep(50);
        if (getWCClass()) return true;
      } catch (e) {
        log("WC load failed: " + (e?.message || String(e)));
      }
    }
    return !!getWCClass();
  }

  let boundEip = null;
  function bindEip1193Events(eip1193, label) {
    if (!eip1193?.on) return;
    if (boundEip === eip1193) return;
    boundEip = eip1193;

    eip1193.on("accountsChanged", async (accounts) => {
      try {
        const a = Array.isArray(accounts) ? accounts[0] : null;
        log(`${label}: accountsChanged -> ${a || "-"}`);
        if (!a) {
          signer = null; userAddr = null;
          setTxButtonsEnabled(false);
          safeText("wallet", "-");
          return;
        }
        if (provider) {
          signer = await provider.getSigner();
          userAddr = await signer.getAddress();
          safeText("wallet", userAddr);
          await refresh();
        }
      } catch (e) {
        log(`${label}: accountsChanged error: ` + (e?.message || String(e)));
      }
    });

    eip1193.on("chainChanged", async (chainIdHex) => {
      try {
        log(`${label}: chainChanged -> ${String(chainIdHex)}`);
        if (provider) {
          const net = await provider.getNetwork();
          const cid = Number(net.chainId);
          safeText("netName", `${cfg.CHAIN_NAME} (cfg ${cfg.CHAIN_ID}) • yours: ${cid} • via: ${label}`);
          setTxButtonsEnabled(cid === Number(cfg.CHAIN_ID));
          await refresh();
          await refreshGlobalStats();
        }
      } catch (e) {
        log(`${label}: chainChanged error: ` + (e?.message || String(e)));
      }
    });

    eip1193.on("disconnect", () => {
      log(`${label}: disconnected`);
      signer = null; userAddr = null;
      setTxButtonsEnabled(false);
      safeText("wallet", "-");
    });
  }

  async function ensureInjectedChain() {
    const eth = window.ethereum;
    if (!eth?.request) return;

    const targetHex = "0x" + Number(cfg.CHAIN_ID).toString(16);
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
            chainName: cfg.CHAIN_NAME,
            rpcUrls: [cfg.RPC_URL],
            nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
            blockExplorerUrls: [cfg.EXPLORER_BASE]
          }]
        });
      } else {
        throw e;
      }
    }
  }

  async function connectWithEIP1193(eip1193, label) {
    provider = new ethers.BrowserProvider(eip1193);

    try { await provider.send("eth_requestAccounts", []); } catch (_) {}

    signer = await provider.getSigner();
    userAddr = await signer.getAddress();
    safeText("wallet", userAddr);

    const net = await provider.getNetwork();
    safeText("netName", `${cfg.CHAIN_NAME} (cfg ${cfg.CHAIN_ID}) • yours: ${Number(net.chainId)} • via: ${label}`);

    if (Number(net.chainId) !== Number(cfg.CHAIN_ID)) {
      setTxButtonsEnabled(false);
      alert(`Wrong network.\n\nConnected: ${Number(net.chainId)}\nRequired: ${Number(cfg.CHAIN_ID)} (${cfg.CHAIN_NAME})`);
    } else {
      setTxButtonsEnabled(true);
    }

    usdt = new ethers.Contract(cfg.USDT_ADDRESS, erc20Abi, signer);
    presale = new ethers.Contract(cfg.PRESALE_ADDRESS, presaleAbi, signer);

    bindEip1193Events(eip1193, label);

    log("Connected: " + userAddr);
    await refresh();
    await refreshGlobalStats();
  }

  async function connectInjected() {
    if (!window.ethereum) throw new Error("Injected wallet tidak ditemukan.\nCoba DApp Browser (Trust/MetaMask) atau extension di desktop.");
    await ensureInjectedChain();
    await connectWithEIP1193(window.ethereum, "Injected");
  }

  async function ensureWalletConnectProvider() {
    const ok = await ensureWalletConnectUMD();
    const WC = getWCClass();

    if (!ok || !WC || typeof WC.init !== "function") {
      throw new Error(
        "WalletConnect UMD tidak terbaca.\n" +
        "Cek Network tab: apakah index.umd.min.js berhasil 200?\n" +
        "Cek Console: window['@walletconnect/ethereum-provider'] harus ada."
      );
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
          url: cfg.SITE_URL,
          icons: [cfg.SITE_ICON || ""].filter(Boolean)
        }
      });
      wcProvider.on?.("disconnect", () => log("WalletConnect disconnected"));
    }
    return wcProvider;
  }

  async function connectWC() {
    const p = await ensureWalletConnectProvider();

    if (typeof p.connect === "function") await p.connect();
    else if (typeof p.enable === "function") await p.enable();

    await connectWithEIP1193(p, "WalletConnect");
  }

  // ----- read-only stats via RPC -----
  let rpc = null, usdtRead = null, tokenRead = null, presaleRead = null;
  try {
    rpc = new ethers.JsonRpcProvider(cfg.RPC_URL);
    usdtRead = new ethers.Contract(cfg.USDT_ADDRESS, erc20Abi, rpc);
    if (cfg.TOKEN_ADDRESS) tokenRead = new ethers.Contract(cfg.TOKEN_ADDRESS, erc20Abi, rpc);
    presaleRead = new ethers.Contract(cfg.PRESALE_ADDRESS, [...presaleAbi, ...presaleStatsAbi], rpc);

    try { cfg.USDT_DECIMALS = Number(await usdtRead.decimals()); } catch (_) {}
    try { if (tokenRead) cfg.TOKEN_DECIMALS = Number(await tokenRead.decimals()); } catch (_) {}
  } catch (e) {
    log("RPC init error: " + (e?.message || String(e)));
  }

  async function trySoldFromContract() {
    if (!presaleRead) return null;
    for (const fn of ["totalSold", "tokensSold", "sold"]) {
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

      const soldFromView = await trySoldFromContract();
      if (soldFromView) sold = parseFloat(ethers.formatUnits(soldFromView.raw, cfg.TOKEN_DECIMALS));

      if (sold === null && tokenRead && PRESALE_CAP > 0) {
        const remainRaw = await tokenRead.balanceOf(cfg.PRESALE_ADDRESS);
        const remain = parseFloat(ethers.formatUnits(remainRaw, cfg.TOKEN_DECIMALS));
        sold = Math.max(0, PRESALE_CAP - remain);
      }

      const buySoldText = $("buySoldText");
      const buySoldBar = $("buySoldBar");
      const buyRaisedText = $("buyRaisedText");

      if (buyRaisedText) buyRaisedText.textContent = `Raised: ${nfmt(raised, 2)} USDT`;

      if (sold == null) {
        if (buySoldText) buySoldText.textContent = `- / ${PRESALE_CAP.toLocaleString()}`;
        if (buySoldBar) buySoldBar.style.width = "0%";
      } else {
        const pct = PRESALE_CAP > 0 ? Math.min(100, (sold / PRESALE_CAP) * 100) : 0;
        if (buySoldText) buySoldText.textContent = `${nfmt(sold, 2)} / ${PRESALE_CAP.toLocaleString()} (${pct.toFixed(2)}%)`;
        if (buySoldBar) buySoldBar.style.width = pct.toFixed(2) + "%";
      }
    } catch (e) {
      log("Global stats error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function refresh() {
    if (!signer) return;
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

  function updateEstimate() {
    const estEl = $("estOut");
    const inp = $("amt");
    if (!estEl || !inp) return;

    const raw = sanitizeAmountStr(inp.value);
    const x = Number(raw);
    if (!raw || !isFinite(x) || x <= 0) {
      estEl.textContent = "Estimated output: -";
      return;
    }
    const rate = cfg.USE_PHASE_RATE_FOR_ESTIMATE ? getUiTokensPerUsdt() : (cfg.BASE_RATE_GOBG_PER_USDT || 15);
    estEl.textContent = `Estimated output: ${(x * rate).toLocaleString()} GOBG`;
  }

  async function approveUSDT() {
    await runLocked("approve", async () => {
      const inp = $("amt");
      if (!inp) return;
      const amt = parseUnitsSafe(inp.value, cfg.USDT_DECIMALS);

      const allowance = await usdt.allowance(userAddr, cfg.PRESALE_ADDRESS);
      const approveValue = cfg.APPROVE_MAX ? ethers.MaxUint256 : amt;

      if (allowance >= amt) { log("Allowance already sufficient."); return; }

      const tx = await usdt.approve(cfg.PRESALE_ADDRESS, approveValue);
      log("Approve tx: " + tx.hash);
      await tx.wait();
      log("Approve confirmed.");
      await refresh();
      await refreshGlobalStats();
    });
  }

  async function buy() {
    await runLocked("buy", async () => {
      const inp = $("amt");
      if (!inp) return;
      const amt = parseUnitsSafe(inp.value, cfg.USDT_DECIMALS);

      const allowance = await usdt.allowance(userAddr, cfg.PRESALE_ADDRESS);
      if (allowance < amt) { log("Allowance too low. Click Approve first."); return; }

      const tx = await presale.buy(amt);
      log("Buy tx: " + tx.hash);
      await tx.wait();
      log("Buy confirmed.");
      await refresh();
      await refreshGlobalStats();
    });
  }

  async function claim() {
    await runLocked("claim", async () => {
      const tx = await presale.claim();
      log("Claim tx: " + tx.hash);
      await tx.wait();
      log("Claim confirmed.");
      await refresh();
      await refreshGlobalStats();
    });
  }

  async function finalize() {
    await runLocked("finalize", async () => {
      const ok = await presale.canFinalizeNow();
      if (!ok) { log("Cannot finalize yet (time not ended / not sold out)."); return; }

      const tx = await presale.finalize();
      log("Finalize tx: " + tx.hash);
      await tx.wait();
      log("Finalize confirmed.");
      await refresh();
      await refreshGlobalStats();
    });
  }

  // ----- modal wiring -----
  const backdrop = $("cmBackdrop");
  const btnInjected = $("cmInjected");
  const btnWC = $("cmWC");
  const btnCancel = $("cmCancel");

  function openModal() {
    if (!backdrop) return;
    if (btnInjected) btnInjected.disabled = !window.ethereum;

    // Jangan disable WC lagi. Biarkan klik -> akan auto-load saat connectWC()
    if (btnWC) {
      btnWC.disabled = false;
      btnWC.style.opacity = "1";
      btnWC.style.pointerEvents = "auto";
      btnWC.title = "Klik untuk WalletConnect (script akan di-load otomatis jika belum siap).";
    }

    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    if (!backdrop) return;
    backdrop.classList.remove("show");
    backdrop.setAttribute("aria-hidden", "true");
  }

  backdrop?.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
  btnCancel?.addEventListener("click", closeModal);

  btnInjected?.addEventListener("click", async () => {
    closeModal();
    try { await connectInjected(); }
    catch (err) {
      const msg = err?.message || String(err);
      log("Connect error: " + msg);
      alert("Connect failed:\n" + msg);
    }
  });

  btnWC?.addEventListener("click", async () => {
    closeModal();
    try { await connectWC(); }
    catch (err) {
      const msg = err?.message || String(err);
      log("Connect error: " + msg);
      alert("Connect failed:\n" + msg);
    }
  });

  $("connectBtn")?.addEventListener("click", (e) => { e.preventDefault(); openModal(); });

  $("approveBtn")?.addEventListener("click", approveUSDT);
  $("buyBtn")?.addEventListener("click", buy);
  $("claimBtn")?.addEventListener("click", claim);
  $("finalizeBtn")?.addEventListener("click", finalize);
  $("amt")?.addEventListener("input", updateEstimate);

  setInterval(() => { if (signer) refresh(); }, 10000);
  setInterval(() => { refreshGlobalStats(); }, 10000);

  refreshGlobalStats();
  updateEstimate();
  log("UI ready.");
})();
