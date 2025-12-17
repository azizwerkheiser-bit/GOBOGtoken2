(async function () {
  const $ = (id) => document.getElementById(id);

  const logEl = $("log");
  const log = (s) => {
    if (!logEl) return;
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    logEl.textContent = `[${ts}] ${s}\n` + logEl.textContent;
  };

  function formatDDHHMMSS(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const dd = Math.floor(s / 86400);
    const hh = Math.floor((s % 86400) / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(dd)}:${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }

  function fmt(x, d) {
    try { return ethers.formatUnits(x, d); } catch (_) { return "-"; }
  }
  function parse(x, d) {
    return ethers.parseUnits(x, d);
  }

  async function loadConfig() {
    // prefer config.js loader if exists
    if (typeof window.loadGobogConfig === "function") {
      return await window.loadGobogConfig();
    }
    // fallback: config.json
    const res = await fetch("./config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} while loading config.json`);
    return await res.json();
  }

  let cfg;
  try {
    cfg = await loadConfig();
  } catch (e) {
    const msg = e?.message || String(e);
    log("Config error: " + msg);
    alert("Failed to load config.json. Make sure it exists and is valid JSON.\n\n" + msg);
    return;
  }

  // Build explorer links if not provided
  const explorerBase = cfg.EXPLORER_BASE || "";
  const presaleExplorer = cfg.PRESALE_EXPLORER_URL || (explorerBase && cfg.PRESALE_ADDRESS ? `${explorerBase}/address/${cfg.PRESALE_ADDRESS}` : "#");
  const tokenExplorer = cfg.TOKEN_EXPLORER_URL || (explorerBase && cfg.TOKEN_ADDRESS ? `${explorerBase}/address/${cfg.TOKEN_ADDRESS}` : "#");

  const exPresale = $("explorerPresale");
  if (exPresale) exPresale.href = presaleExplorer;

  const exToken = $("explorerToken");
  if (exToken) exToken.href = tokenExplorer;

  // ---- ABI ----
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

  // ---- Phase schedule (UI) ----
  function buildTimeline() {
    const phases = cfg.PHASES || [];
    const start = Number(cfg.PRESALE_START_TIME || 0);
    if (!start || phases.length === 0) return { start, timeline: [] };

    let t = start;
    const timeline = phases.map((p) => {
      const durDays = Number(p.duration_days || 7);
      const durSec = Math.max(1, Math.floor(durDays * 86400));
      const seg = { ...p, start: t, end: t + durSec, durDays };
      t += durSec;
      return seg;
    });

    return { start, timeline };
  }

  function getActivePhase(now) {
    const { start, timeline } = buildTimeline();
    if (!start || timeline.length === 0) {
      return { idx: -1, phase: null, phaseEnd: start || 0, timeline };
    }

    const totalEnd = timeline[timeline.length - 1].end;

    if (now < start) return { idx: -1, phase: null, phaseEnd: start, timeline };

    const idx = timeline.findIndex((seg) => now >= seg.start && now < seg.end);

    if (idx === -1 && now >= totalEnd) {
      return { idx: timeline.length, phase: null, phaseEnd: totalEnd, timeline };
    }

    return { idx, phase: timeline[idx], phaseEnd: timeline[idx].end, timeline };
  }

  function renderPhases() {
    const listEl = $("phaseList");
    const activeEl = $("phaseActive");
    const cdEl = $("phaseCountdown");
    if (!listEl || !activeEl || !cdEl) return;

    const now = Math.floor(Date.now() / 1000);
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

    listEl.innerHTML = info.timeline
      .map((p, i) => {
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
      })
      .join("");
  }

  function getUiTokensPerUsdt() {
    const now = Math.floor(Date.now() / 1000);
    const info = getActivePhase(now);
    if (info.idx >= 0 && info.idx < info.timeline.length) {
      const v = Number(info.phase?.gobg_per_1_usdt);
      if (isFinite(v) && v > 0) return v;
    }
    return 15;
  }

  renderPhases();
  setInterval(renderPhases, 1000);

  // ---- Providers / WalletConnect ----
  function getWcUmd() {
    // Different UMD builds expose different globals
    return (
      window.EthereumProvider ||
      window.WalletConnectEthereumProvider ||
      window.WalletConnectEthereumProvider?.default ||
      null
    );
  }

  async function initWalletConnect({ forceQr = false } = {}) {
    const WC = getWcUmd();
    if (!WC || typeof WC.init !== "function") {
      throw new Error("WalletConnect provider script not loaded. Check the <script> tag for @walletconnect/ethereum-provider.");
    }
    if (!cfg.WALLETCONNECT_PROJECT_ID) {
      throw new Error("Missing WALLETCONNECT_PROJECT_ID in config.json");
    }
    if (!cfg.RPC_URL) {
      throw new Error("Missing RPC_URL in config.json");
    }

    // WalletConnect modal will handle QR on desktop + wallet list / deep link on mobile
   // ganti semua window.EthereumProvider jadi ini:
const WCProvider = window.EthereumProvider || window.WalletConnectEthereumProvider;

if (!WCProvider) {
  throw new Error("WalletConnect provider script not loaded (EthereumProvider missing). Check the <script src=...> URL.");
}

// lalu pakai:
wcProvider = await WCProvider.init({
  projectId,
  chains: [Number(cfg.CHAIN_ID)],
  showQrModal: true
});

    // If you want to force showing QR modal even on some environments:
    // call connect() explicitly
    await wcProvider.connect();

    // Small hint: "forceQr" kept for future tweaks; modal already decides best UX.
    void forceQr;

    return wcProvider;
  }

  let provider;      // ethers BrowserProvider
  let signer;        // ethers Signer
  let userAddr;
  let usdt;
  let presale;

  async function trySwitchOrAddChain(eip1193) {
    // best effort: wallet may reject, it's ok.
    if (!eip1193?.request) return;

    const chainIdHex = "0x" + Number(cfg.CHAIN_ID).toString(16);

    try {
      await eip1193.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainIdHex }]
      });
      return;
    } catch (_) {
      // try add
    }

    try {
      await eip1193.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chainIdHex,
          chainName: cfg.CHAIN_NAME || "Custom Chain",
          rpcUrls: [cfg.RPC_URL],
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          blockExplorerUrls: [cfg.EXPLORER_BASE].filter(Boolean)
        }]
      });
    } catch (_) {
      // ignore
    }
  }

  async function ensureNetwork(eip1193) {
    if (!eip1193) throw new Error("Wallet provider not found.");
    provider = new ethers.BrowserProvider(eip1193);

    const net = await provider.getNetwork();
    const netName = $("netName");
    if (netName) netName.textContent = `${cfg.CHAIN_NAME} (cfg ${cfg.CHAIN_ID}) • yours: ${Number(net.chainId)}`;

    if (Number(net.chainId) !== Number(cfg.CHAIN_ID)) {
      log(`Network mismatch. Switching to chainId ${cfg.CHAIN_ID}...`);
      await trySwitchOrAddChain(eip1193);
    }
  }

  async function connectWith(eip1193) {
    await ensureNetwork(eip1193);

    // request accounts (injected + wc)
    try { await provider.send("eth_requestAccounts", []); } catch (_) {}

    signer = await provider.getSigner();
    userAddr = await signer.getAddress();

    const w = $("wallet");
    if (w) w.textContent = userAddr;

    usdt = new ethers.Contract(cfg.USDT_ADDRESS, erc20Abi, signer);
    presale = new ethers.Contract(cfg.PRESALE_ADDRESS, presaleAbi, signer);

    log("Connected: " + userAddr);
    await refresh();
  }

  async function refresh() {
    if (!signer) return;
    try {
      const [bal, cl, end] = await Promise.all([
        usdt.balanceOf(userAddr),
        presale.claimable(userAddr),
        presale.endTime()
      ]);

      const ub = $("usdtBal");
      if (ub) ub.textContent = fmt(bal, cfg.USDT_DECIMALS);

      const c = $("claimable");
      if (c) c.textContent = fmt(cl, cfg.TOKEN_DECIMALS);

      const e = $("ends");
      if (e) e.textContent = new Date(Number(end) * 1000).toLocaleString();

    } catch (e) {
      log("Refresh error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function approveUSDT() {
    const amtEl = $("amt");
    const amtStr = (amtEl?.value || "").trim();
    if (!amtStr) return alert("Enter USDT amount first.");
    const amt = parse(amtStr, cfg.USDT_DECIMALS);

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
    } catch (e) {
      log("Approve error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function buy() {
    const amtEl = $("amt");
    const amtStr = (amtEl?.value || "").trim();
    if (!amtStr) return alert("Enter USDT amount first.");
    const amt = parse(amtStr, cfg.USDT_DECIMALS);

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
    } catch (e) {
      log("Buy error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function claim() {
    try {
      const tx = await presale.claim();
      log("Claim tx: " + tx.hash);
      await tx.wait();
      log("Claim confirmed.");
      await refresh();
    } catch (e) {
      log("Claim error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  async function finalize() {
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
    } catch (e) {
      log("Finalize error: " + (e?.shortMessage || e?.message || String(e)));
    }
  }

  function updateEstimate() {
    const amtEl = $("amt");
    const outEl = $("estOut");
    if (!outEl) return;

    const amtStr = (amtEl?.value || "").trim();
    if (!amtStr) { outEl.textContent = "Estimated output: -"; return; }

    const x = Number(amtStr);
    if (!isFinite(x) || x <= 0) { outEl.textContent = "Estimated output: -"; return; }

    const rate = cfg.USE_PHASE_RATE_FOR_ESTIMATE ? getUiTokensPerUsdt() : 15;
    const tag = cfg.USE_PHASE_RATE_FOR_ESTIMATE ? "UI phase rate" : "Base rate";
    const out = x * rate;

    outEl.textContent = `Estimated output (${tag}): ${out.toLocaleString()} GOBG`;
  }

  // ---- Buttons ----
  const connectBtn = $("connectBtn");
  const connectQrBtn = $("connectQrBtn");

  async function onConnectMain() {
    try {
      // Desktop with extension: use injected first
      if (window.ethereum) {
        await connectWith(window.ethereum);
        return;
      }
      // Mobile / no extension: WalletConnect
      const wc = await initWalletConnect({ forceQr: false });
      await connectWith(wc);
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      log("Connect error: " + msg);
      alert("Connect failed: " + msg);
    }
  }

  async function onConnectQr() {
    try {
      const wc = await initWalletConnect({ forceQr: true });
      await connectWith(wc);
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      log("Connect(QR) error: " + msg);
      alert("Connect failed: " + msg);
    }
  }

  if (connectBtn) connectBtn.addEventListener("click", onConnectMain);
  if (connectQrBtn) connectQrBtn.addEventListener("click", onConnectQr);

  const approveBtn = $("approveBtn");
  const buyBtn = $("buyBtn");
  const claimBtn = $("claimBtn");
  const finalizeBtn = $("finalizeBtn");
  const amt = $("amt");

  if (approveBtn) approveBtn.addEventListener("click", approveUSDT);
  if (buyBtn) buyBtn.addEventListener("click", buy);
  if (claimBtn) claimBtn.addEventListener("click", claim);
  if (finalizeBtn) finalizeBtn.addEventListener("click", finalize);
  if (amt) amt.addEventListener("input", updateEstimate);

  setInterval(() => { if (signer) refresh(); }, 10000);

})();
